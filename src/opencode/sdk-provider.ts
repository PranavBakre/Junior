/**
 * OpenCode SDK/Server provider.
 *
 * Unlike the CLI adapter (`spawnOpenCode` which runs `opencode run` per turn),
 * this provider starts (or attaches to) an `opencode serve` process and uses
 * the @opencode-ai/sdk client to send prompts, subscribe to events, and
 * interrupt sessions with the same session abort API used by the OpenCode TUI.
 *
 * When OPENCODE_CONTINUITY_ENABLED=true, sessions carry conversation context
 * across completed turns, so the SDK provider re-attaches to the same session
 * ID. Prompt-after-abort continuation still needs a fixture before Junior can
 * treat timeout recovery as verified continuity.
 */

import { dirname, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { AgentIdentity, ThreadSession } from "../session/types.ts";
import type { RunnerEvent, SpawnHandle, SpawnResult } from "../runners/types.ts";
import { buildRunnerRuntime } from "../runners/runtime.ts";
import { compileOpenCodePermission } from "../runners/policy.ts";
import { OPENCODE_PROVIDER_AGENT, buildOpenCodeAgentPrompt } from "./prompt.ts";
import { buildOpenCodeConfigContent } from "./config.ts";
import { resolveOpenCodeModel } from "./model.ts";
import { log as _log } from "../logger.ts";
import { buildOpenCodeMcpConfig } from "../runners/mcp-config.ts";
import { resolveTrustedSkill } from "../skills/registry.ts";
import {
  prepareSkillRuntime,
  skillInvocationPrompt,
} from "../skills/runtime.ts";

// ---------------------------------------------------------------------------
// Types mirroring @opencode-ai/sdk (resolved dynamically at runtime)
// ---------------------------------------------------------------------------

interface SdkTextPart {
  type: "text";
  text: string;
  id?: string;
  sessionID?: string;
  messageID?: string;
}

interface SdkToolPart {
  type: "tool";
  tool: string;
  state: { status: string; input?: Record<string, unknown> };
  callID?: string;
  id?: string;
  sessionID?: string;
  messageID?: string;
}

interface SdkStepFinishPart {
  type: "step-finish";
  reason?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
  id?: string;
  sessionID?: string;
  messageID?: string;
}

type SdkEventPart = SdkTextPart | SdkToolPart | SdkStepFinishPart | {
  type: string;
  [key: string]: unknown;
};

interface OpencodeClient {
  session: {
    create(args?: { directory?: string; agent?: string }): Promise<{ id: string }>;
    prompt(args: { sessionID: string; message: { role: string; parts: Array<{ type: string; text?: string }> } }): Promise<unknown>;
    abort(args: { sessionID: string }): Promise<unknown>;
  };
  event: {
    subscribe(args: { directory?: string }): AsyncIterable<{ data: string }>;
  };
  config: {
    update(args: { config: Record<string, unknown> }): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle (shared across all SDK spawns)
// ---------------------------------------------------------------------------

let _sdkModule: {
  createOpencode: (options?: { directory?: string }) => Promise<{
    client: OpencodeClient;
    server: { url: string; close(): void };
  }>;
} | null = null;

async function loadSdk(): Promise<NonNullable<typeof _sdkModule>> {
  if (_sdkModule) return _sdkModule;
  // The SDK lives inside the OpenCode installation, not in junior's
  // node_modules. Resolve from the opencode bin directory.
  const opencodeBin = process.env.OPENCODE_BIN
    ?? resolve(process.env.HOME ?? "/Users/psbakre", ".opencode", "bin", "opencode");
  const sdkDir = resolve(dirname(dirname(opencodeBin)), "node_modules", "@opencode-ai", "sdk");
  const mod = await import(sdkDir) as NonNullable<typeof _sdkModule>;
  _sdkModule = mod;
  return mod;
}

interface SdkServerState {
  client: OpencodeClient;
  close(): void;
  refs: number;
  closed: boolean;
}

const servers = new Map<string, SdkServerState>();

async function getOrCreateServer(directory: string): Promise<SdkServerState> {
  const existing = servers.get(directory);
  if (existing && !existing.closed) {
    existing.refs += 1;
    return existing;
  }
  const sdk = await loadSdk();
  const { client, server } = await sdk.createOpencode({ directory });
  const state = {
    client,
    close: server.close,
    refs: 1,
    closed: false,
  };
  servers.set(directory, state);
  _log.info("opencode-sdk", `server started url=${server.url} dir=${directory}`);
  return state;
}

function releaseServer(directory: string, server: SdkServerState): void {
  if (server.closed) return;
  server.refs = Math.max(0, server.refs - 1);
  if (server.refs > 0) return;
  server.closed = true;
  if (servers.get(directory) === server) servers.delete(directory);
  try { server.close(); } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Main spawn function
// ---------------------------------------------------------------------------

export function spawnOpenCodeSdk(
  session: ThreadSession,
  prompt: string,
  config: Config,
  targetRepoCwd?: string,
  botToken?: string,
  agentIdentity?: AgentIdentity,
  _imagePaths: string[] = [],
  githubAuthEnv?: Record<string, string>,
): SpawnHandle {
  const provider = "opencode-sdk" as const;
  const runtime = buildRunnerRuntime({
    session,
    targetRepoCwd,
    botToken,
    agentIdentity,
    githubAuthEnv,
  });
  const activeSkill = session.activeSkill
    ? resolveTrustedSkill(session.activeSkill.name)
    : null;
  if (
    session.activeSkill &&
    (!activeSkill || activeSkill.path !== session.activeSkill.path)
  ) {
    throw new Error("active skill does not match Junior's trusted registry");
  }
  const skillRuntime = activeSkill ? prepareSkillRuntime(activeSkill) : null;
  const effectivePrompt = activeSkill
    ? skillInvocationPrompt("opencode", activeSkill, prompt)
    : prompt;

  const agentName = session.activeAgentName ?? OPENCODE_PROVIDER_AGENT;
  // The CLI spawner uses `juniorAgentName` to distinguish from the OpenCode
  // native agent name. Keep the same naming for config generation.
  const juniorAgentName = agentName;

  // Generate config the same way the CLI provider does — embedded agent prompt,
  // MCP wiring, and subagents.
  const model = resolveOpenCodeModel(session.model, config.opencode.model);
  const agentPrompt = buildOpenCodeAgentPrompt({
    juniorAgentName,
    juniorPrompt: session.systemPrompt ?? undefined,
  });
  const generatedConfig = buildOpenCodeConfigContent({
    agentName,
    agentPrompt,
    description: "Junior SDK runner",
    model,
    permission: compileOpenCodePermission({
      subject: session,
      cwd: runtime.cwd,
      fallback: config.opencode.permission,
    }),
    mcp: session.cwd ? null : buildOpenCodeMcpConfig(config, session),
    // Junior's durable assignment graph owns fan-out.
    subagents: [],
  });

  let sdkSessionId: string | null = null;
  let activeServer: SdkServerState | null = null;
  let aborted = false;
  let finishTurn: (() => void) | null = null;
  const eventListeners: Array<(event: RunnerEvent) => void> = [];

  const spawnResult = new Promise<SpawnResult>(async (resolve, reject) => {
    let leasedDirectory: string | null = null;
    let leasedServer: SdkServerState | null = null;
    try {
      const cwd = skillRuntime?.openCodeSdkDir ?? runtime.cwd ?? process.cwd();
      const server = await getOrCreateServer(cwd);
      leasedDirectory = cwd;
      leasedServer = server;
      activeServer = server;
      if (aborted) {
        resolve({
          provider,
          sessionId: null,
          response: "",
          events: [],
          exitCode: 0,
          error: null,
        });
        return;
      }

      // Push generated config. Best-effort — server may already have config.
      try {
        await server.client.config.update({
          config: JSON.parse(generatedConfig),
        });
      } catch {
        // ok
      }
      if (aborted) {
        resolve({
          provider,
          sessionId: null,
          response: "",
          events: [],
          exitCode: 0,
          error: null,
        });
        return;
      }

      // Create session, or re-attach to existing only when continuity is
      // explicitly enabled. OpenCode continuity means reusing session context
      // across completed turns. SDK abort is the native interrupt path, but
      // prompt-after-abort continuation still needs a fixture before treating it
      // as timeout recovery.
      let currentSessionId = config.opencode.continuityEnabled
        ? (session.sessionId ?? undefined)
        : undefined;
      if (!currentSessionId) {
        const created = await server.client.session.create({ directory: cwd, agent: agentName }) as { id: string };
        currentSessionId = created.id;
      }
      sdkSessionId = currentSessionId;
      if (aborted) {
        resolve({
          provider,
          sessionId: currentSessionId,
          response: "",
          events: [],
          exitCode: 0,
          error: null,
        });
        return;
      }

      // Subscribe to events before sending prompt
      const events: RunnerEvent[] = [];
      let pendingText = "";
      let sessionIdCaptured = false;

      const emit = (event: RunnerEvent) => {
        events.push(event);
        for (const listener of eventListeners) {
          try { listener(event); } catch { /* ignore */ }
        }
      };

      const eventStream = server.client.event.subscribe({ directory: cwd });
      let resolveTurn!: () => void;
      const turnDone = new Promise<void>((resolve) => {
        resolveTurn = resolve;
        finishTurn = resolve;
      });
      if (aborted) {
        resolveTurn();
        resolve({
          provider,
          sessionId: currentSessionId,
          response: "",
          events: [],
          exitCode: 0,
          error: null,
        });
        return;
      }
      const eventConsumer = (async () => {
        try {
          for await (const raw of eventStream) {
            if (aborted) break;
            try {
              const part = (typeof raw.data === "string" ? JSON.parse(raw.data) : raw.data) as SdkEventPart;
              const partSessionId = "sessionID" in part ? (part as { sessionID?: string }).sessionID : undefined;
              if (partSessionId && partSessionId !== currentSessionId) continue;

              // Capture session ID from first part carrying one
              if (!sessionIdCaptured) {
                const sid = partSessionId;
                if (sid) {
                  sessionIdCaptured = true;
                  emit({ type: "init", provider, sessionId: sid });
                }
              }

              if (part.type === "text") {
                pendingText += (part as SdkTextPart).text ?? "";
              }

              if (part.type === "tool") {
                const toolPart = part as SdkToolPart;
                const toolName = toolPart.tool ?? "unknown";
                const status = toolPart.state?.status ?? "started";
                emit({
                  type: "tool",
                  provider,
                  name: toolName.charAt(0).toUpperCase() + toolName.slice(1),
                  input: toolPart.state?.input ?? {},
                  status: status === "completed" ? "completed" : "started",
                });
              }

              if (part.type === "step-finish") {
                if (pendingText.trim()) {
                  emit({ type: "message", provider, text: pendingText.trimEnd() });
                  pendingText = "";
                }
                const stepPart = part as SdkStepFinishPart;
                const usage = stepPart.tokens
                  ? { input: stepPart.tokens.input ?? 0, output: stepPart.tokens.output ?? 0 }
                  : undefined;
                emit({ type: "done", provider, usage });
                finishTurn?.();
                break;
              }
            } catch {
              // Skip unparseable events
            }
          }
        } catch {
          // Event stream ended or errored
        }
      })();

      // Send the prompt
      try {
        await server.client.session.prompt({
          sessionID: currentSessionId,
          message: {
            role: "user",
            parts: [{ type: "text", text: effectivePrompt }],
          },
        });
      } catch (err) {
        if (aborted) {
          resolve({ provider, sessionId: currentSessionId, response: "", events, exitCode: 0, error: null });
          return;
        }
        reject(err);
        return;
      }

      // The SDK subscription is server-lived; a Junior turn is complete when
      // the active SDK session emits step-finish, not when the stream closes.
      await turnDone;
      await eventConsumer;

      const responseText = events
        .filter((e) => e.type === "message")
        .map((e) => (e as { text: string }).text)
        .join("\n\n");

      resolve({ provider, sessionId: currentSessionId, response: responseText, events, exitCode: 0, error: null });
    } catch (err) {
      if (aborted) {
        resolve({ provider, sessionId: sdkSessionId, response: "", events: [], exitCode: 0, error: null });
        return;
      }
      reject(err);
    } finally {
      if (leasedDirectory && leasedServer) {
        releaseServer(leasedDirectory, leasedServer);
      }
    }
  });

  return {
    provider,
    result: spawnResult,
    onEvent: (cb: (event: RunnerEvent) => void) => {
      eventListeners.push(cb);
    },
    kill: async (_signal) => {
      aborted = true;
      const server = activeServer;
      if (sdkSessionId && server) {
        try {
          await server.client.session.abort({ sessionID: sdkSessionId });
        } catch {
          // ok
        }
      }
      finishTurn?.();
    },
    pid: null,
  };
}
