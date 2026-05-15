import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readdirSync, statSync, watch as fsWatch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import type { ClaudeDriver, DriverMode, DriverSendInput } from "./driver.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "./types.ts";
import { buildClaudeArgs } from "./args.ts";
import { adaptTranscriptLine } from "./transcript-adapter.ts";

/**
 * Test seam — let unit tests inject a fake tmux invoker and override the
 * projects-root path so we don't touch the real ~/.claude/projects.
 */
export interface TmuxDriverOptions {
  /** Override `~/.claude/projects` for tests. */
  projectsRoot?: string;
  /** Override the tmux binary (default "tmux"). */
  tmuxBin?: string;
  /**
   * Test seam. Production passes nothing and we shell out to tmux directly.
   * Returns stdout (trimmed). Throws on non-zero exit.
   */
  exec?: (cmd: string, args: string[]) => Promise<string>;
}

interface TmuxSession {
  name: string;
  cwd: string;
  sessionId: string | null;
  /** Last transcript file we know about — chosen on first turn, updated on resume. */
  transcriptPath: string | null;
  /** Byte offset we've consumed so far. */
  transcriptOffset: number;
  /** Live fs watcher for the transcript file (or its parent dir until the file exists). */
  watcher: FSWatcher | null;
  /** Polling timer for file-discovery (macOS fs.watch misses create events). */
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Listeners attached to the live SpawnHandle for the current turn, if any. */
  activeTurn: ActiveTurn | null;
  /** Wall-clock cutoff for transcript-file selection — only files mtime >= this match. */
  startedAt: number;
  /** Serializes drainTranscript — fs.watch and the poll timer both fire it. */
  drainInFlight: boolean;
  /** Set when a drain request arrives while one is already running. */
  drainPending: boolean;
}

interface ActiveTurn {
  listeners: Array<(event: StreamEvent) => void>;
  events: StreamEvent[];
  lastAssistantText: string;
  resultText: string;
  resolve: (result: SpawnResult) => void;
  rejected: boolean;
  /** Process group ID inside tmux pane, when discovered (for kill -INT during interrupt). */
  pid: number | null;
}

const SESSION_NAME_MAX = 200;

export class TmuxDriver implements ClaudeDriver {
  readonly mode: DriverMode = "tmux";
  private projectsRoot: string;
  private tmuxBin: string;
  private execImpl: (cmd: string, args: string[]) => Promise<string>;
  /** Per-(thread, agent) tmux session state. Lifetime = thread/agent lifetime. */
  private sessions = new Map<string, TmuxSession>();

  constructor(opts: TmuxDriverOptions = {}) {
    this.projectsRoot = opts.projectsRoot ?? join(homedir(), ".claude", "projects");
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    this.execImpl = opts.exec ?? defaultExec;
  }

  send(input: DriverSendInput): SpawnHandle {
    const key = handleKey(input.threadId, input.agentName);
    const listeners: Array<(event: StreamEvent) => void> = [];
    const events: StreamEvent[] = [];

    const turn: ActiveTurn = {
      listeners,
      events,
      lastAssistantText: "",
      resultText: "",
      resolve: () => undefined,
      rejected: false,
      pid: null,
    };

    const resultPromise = new Promise<SpawnResult>((resolve) => {
      turn.resolve = resolve;
    });

    (async () => {
      try {
        await this.ensureSession(input);
        const session = this.sessions.get(key);
        if (!session) throw new Error(`tmux session lookup failed for ${key}`);
        session.activeTurn = turn;
        await this.pastePromptAndSubmit(session.name, input.prompt);
      } catch (err) {
        turn.resolve({
          sessionId: this.sessions.get(key)?.sessionId ?? null,
          response: "",
          events,
          exitCode: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return {
      result: resultPromise,
      onEvent: (cb) => {
        listeners.push(cb);
      },
      kill: () => {
        // Equivalent to interrupt() — send Escape to halt the turn.
        const sess = this.sessions.get(key);
        if (sess) {
          this.sendKeys(sess.name, "Escape", "Escape").catch(() => undefined);
        }
        const result: SpawnResult = {
          sessionId: this.sessions.get(key)?.sessionId ?? null,
          response: turn.resultText || turn.lastAssistantText,
          events,
          exitCode: null,
          error: "interrupted",
        };
        if (!turn.rejected) {
          turn.rejected = true;
          turn.resolve(result);
        }
      },
      pid: null,
    };
  }

  async interrupt(threadId: string, agentName: string): Promise<void> {
    const sess = this.sessions.get(handleKey(threadId, agentName));
    if (!sess) return;
    await this.sendKeys(sess.name, "Escape", "Escape");
    // Resolve the in-flight turn (if any) — Escape stops the model but the
    // `turn_duration` line may never arrive, leaving runClaudeWithAgent's
    // `await` hung. Today only `!stop` calls interrupt and it pairs with
    // handle.kill() which resolves separately, so the bug is latent — but a
    // future caller that uses interrupt() alone would deadlock. Mirror the
    // close() shape; kill the turn's result promise either way.
    const turn = sess.activeTurn;
    if (turn && !turn.rejected) {
      turn.rejected = true;
      turn.resolve({
        sessionId: sess.sessionId,
        response: turn.resultText || turn.lastAssistantText,
        events: turn.events,
        exitCode: null,
        error: "interrupted",
      });
      sess.activeTurn = null;
    }
  }

  async close(threadId: string, agentName: string): Promise<void> {
    const key = handleKey(threadId, agentName);
    const sess = this.sessions.get(key);
    if (!sess) return;
    // Symmetric to kill(): if a turn is mid-flight, resolve its result
    // promise. Otherwise runClaudeWithAgent's `await` hangs forever and the
    // session stays status="busy" — !driver and !reset would deadlock the
    // thread if they tear down during a turn.
    const turn = sess.activeTurn;
    if (turn && !turn.rejected) {
      turn.rejected = true;
      turn.resolve({
        sessionId: sess.sessionId,
        response: turn.resultText || turn.lastAssistantText,
        events: turn.events,
        exitCode: null,
        error: "driver-closed",
      });
    }
    sess.watcher?.close();
    if (sess.pollTimer) clearInterval(sess.pollTimer);
    sess.activeTurn = null;
    await this.killTmuxSession(sess.name).catch(() => undefined);
    this.sessions.delete(key);
  }

  /**
   * Snapshot of live state — used by reconciliation/eviction to walk active
   * tmux sessions without touching the underlying tmux server.
   */
  listSessions(): Array<{ threadId: string; agentName: string; name: string; sessionId: string | null }> {
    const out: Array<{ threadId: string; agentName: string; name: string; sessionId: string | null }> = [];
    for (const [key, sess] of this.sessions) {
      const [threadId, agentName] = splitKey(key);
      out.push({ threadId, agentName, name: sess.name, sessionId: sess.sessionId });
    }
    return out;
  }

  /** Re-attach state for a session already running in tmux (called by reconciliation). */
  async adoptExistingSession(input: {
    threadId: string;
    agentName: string;
    cwd: string;
    tmuxSessionName: string;
    sessionId: string | null;
  }): Promise<void> {
    const key = handleKey(input.threadId, input.agentName);
    if (this.sessions.has(key)) return;
    if (!(await this.tmuxHasSession(input.tmuxSessionName))) return;
    const transcriptPath = input.sessionId
      ? this.transcriptPathFor(input.cwd, input.sessionId)
      : null;
    const sess: TmuxSession = {
      name: input.tmuxSessionName,
      cwd: input.cwd,
      sessionId: input.sessionId,
      transcriptPath,
      transcriptOffset: 0,
      watcher: null,
      pollTimer: null,
      activeTurn: null,
      startedAt: Date.now() - 86_400_000, // Adopt anything that already exists.
      drainInFlight: false,
      drainPending: false,
    };
    this.sessions.set(key, sess);
    // Skip past the existing transcript on disk — we're picking up mid-session
    // and only care about new content. If the file isn't there yet (sessionId
    // null at adopt time, or the path moved), the watcher's findLatestTranscript
    // fallback locates it on the next file event.
    if (transcriptPath && existsSync(transcriptPath)) {
      sess.transcriptOffset = statSync(transcriptPath).size;
    }
    this.startTranscriptWatch(sess);
  }

  async tmuxHasSession(name: string): Promise<boolean> {
    try {
      await this.execImpl(this.tmuxBin, ["has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * "Has session" plus a wedged-pane check. tmux happily keeps the session
   * alive after claude exits inside it (process crash, `/exit`, OOM) — the
   * pane drops back to the shell prompt. Without this check we'd keep pasting
   * prompts into a dead shell until the per-turn timeout each time. Treat a
   * pane sitting at a known shell as "not usable, cold-start a fresh tmux."
   */
  async tmuxSessionUsable(name: string): Promise<boolean> {
    if (!(await this.tmuxHasSession(name))) return false;
    try {
      const cmd = (
        await this.execImpl(this.tmuxBin, [
          "display-message",
          "-p",
          "-t",
          name,
          "#{pane_current_command}",
        ])
      ).trim();
      // Known shells indicate claude has exited and we're at a prompt.
      // Empty string (test stubs, older tmux) is treated as usable to avoid
      // false-positive cold-starts.
      const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh"]);
      return !SHELLS.has(cmd);
    } catch {
      // If display-message itself fails, fall back to the has-session result —
      // we already know the session exists; we just couldn't probe the pane.
      return true;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────

  private async ensureSession(input: DriverSendInput): Promise<void> {
    const key = handleKey(input.threadId, input.agentName);
    const existing = this.sessions.get(key);
    // tmuxSessionUsable rejects panes where claude has exited and the pane is
    // sitting at a shell — keeps us from pasting into a dead shell each turn.
    if (existing && (await this.tmuxSessionUsable(existing.name))) {
      return;
    }
    if (existing) {
      existing.watcher?.close();
      if (existing.pollTimer) clearInterval(existing.pollTimer);
      // Kill the wedged tmux session before we cold-start a fresh one with the
      // same deterministic name — otherwise new-session collides.
      await this.killTmuxSession(existing.name).catch(() => undefined);
      this.sessions.delete(key);
    }

    const cwd = input.session.cwd
      ?? input.session.worktreePath
      ?? input.targetRepoCwd
      ?? process.cwd();
    mkdirSync(cwd, { recursive: true });

    const sessionName = computeSessionName(input.threadId, input.agentName);
    const startedAt = Date.now();

    const claudeArgs = buildInteractiveClaudeArgs(input);
    await this.execImpl(this.tmuxBin, [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      cwd,
      "claude",
      ...claudeArgs,
    ]);

    const sess: TmuxSession = {
      name: sessionName,
      cwd,
      sessionId: input.session.sessionId,
      transcriptPath: input.session.sessionId
        ? this.transcriptPathFor(cwd, input.session.sessionId)
        : null,
      transcriptOffset: 0,
      watcher: null,
      pollTimer: null,
      activeTurn: null,
      startedAt,
      drainInFlight: false,
      drainPending: false,
    };
    this.sessions.set(key, sess);
    this.startTranscriptWatch(sess);
  }

  private async pastePromptAndSubmit(sessionName: string, prompt: string): Promise<void> {
    const bufName = `junior-${sessionName}-${Date.now()}`;
    // `tmux load-buffer -` reads from stdin — we pipe `prompt` in via the
    // exec impl. The production impl spawns a process so stdin is OK.
    await this.loadBufferFromString(bufName, prompt);
    await this.execImpl(this.tmuxBin, ["paste-buffer", "-p", "-b", bufName, "-t", sessionName]);
    await this.execImpl(this.tmuxBin, ["delete-buffer", "-b", bufName]).catch(() => undefined);
    await this.execImpl(this.tmuxBin, ["send-keys", "-t", sessionName, "Enter"]);
  }

  private async loadBufferFromString(bufName: string, contents: string): Promise<void> {
    // Bun.spawn supports `stdin: ReadableStream | "pipe"`. We use the exec
    // impl's plain stdout signature so tests can stub; the production impl
    // shadows this with a stdin-aware variant below.
    if (this.execImpl === defaultExec) {
      await execWithStdin(this.tmuxBin, ["load-buffer", "-b", bufName, "-"], contents);
      return;
    }
    // Test path: encode the contents as an argv via base64 so fake exec
    // implementations don't need stdin handling.
    await this.execImpl(this.tmuxBin, ["load-buffer", "-b", bufName, "--", contents]);
  }

  private async sendKeys(sessionName: string, ...keys: string[]): Promise<void> {
    await this.execImpl(this.tmuxBin, ["send-keys", "-t", sessionName, ...keys]);
  }

  private async killTmuxSession(name: string): Promise<void> {
    await this.execImpl(this.tmuxBin, ["kill-session", "-t", name]);
  }

  private transcriptPathFor(cwd: string, sessionId: string): string {
    return join(this.projectsRoot, encodeCwd(cwd), `${sessionId}.jsonl`);
  }

  private startTranscriptWatch(sess: TmuxSession): void {
    if (sess.watcher) sess.watcher.close();
    if (sess.pollTimer) clearInterval(sess.pollTimer);
    const dir = join(this.projectsRoot, encodeCwd(sess.cwd));
    mkdirSync(dir, { recursive: true });
    const onChange = () => {
      this.drainTranscript(sess).catch((err) => {
        console.warn("[tmux-driver] transcript drain error:", err);
      });
    };
    // Watch the directory — when the transcript file is created or appended,
    // fs.watch fires. On macOS this requires recursive: false (default).
    const watcher = fsWatch(dir, { persistent: false }, onChange);
    // Without an 'error' handler an EPERM/ENOENT (e.g., the worktree dir is
    // removed during teardown) becomes an unhandled event and crashes the bot.
    watcher.on("error", (err) => {
      console.warn("[tmux-driver] watcher error:", err);
    });
    sess.watcher = watcher;
    // fs.watch on macOS misses some create events for files appearing inside
    // a watched dir. Poll as a fallback until we've located the transcript;
    // once we have a path, fs.watch handles appends reliably and we stop.
    let ticks = 0;
    sess.pollTimer = setInterval(() => {
      ticks++;
      onChange();
      // Stop polling once the transcript is located, or after ~30s.
      if ((sess.transcriptPath && existsSync(sess.transcriptPath)) || ticks >= 120) {
        if (sess.pollTimer) {
          clearInterval(sess.pollTimer);
          sess.pollTimer = null;
        }
      }
    }, 250);
    // Kick off an initial drain in case events were already on disk.
    onChange();
  }

  private async drainTranscript(sess: TmuxSession): Promise<void> {
    // fs.watch and the 250ms poll timer both call this — without serialization
    // they race on (read offset → stat → write offset) and dispatch duplicate
    // assistant events (double Slack updates).
    if (sess.drainInFlight) {
      sess.drainPending = true;
      return;
    }
    sess.drainInFlight = true;
    try {
      do {
        sess.drainPending = false;
        await this.drainTranscriptOnce(sess);
      } while (sess.drainPending);
    } finally {
      sess.drainInFlight = false;
    }
  }

  private async drainTranscriptOnce(sess: TmuxSession): Promise<void> {
    if (!sess.transcriptPath || !existsSync(sess.transcriptPath)) {
      sess.transcriptPath = this.findLatestTranscript(sess);
      if (!sess.transcriptPath) return;
    }

    const file = await open(sess.transcriptPath, "r");
    try {
      const stats = await file.stat();
      if (stats.size <= sess.transcriptOffset) return;
      const length = stats.size - sess.transcriptOffset;
      const buf = new Uint8Array(length);
      await file.read(buf, 0, length, sess.transcriptOffset);
      sess.transcriptOffset = stats.size;
      const text = new TextDecoder().decode(buf);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.processTranscriptLine(sess, line);
      }
    } finally {
      await file.close();
    }
  }

  private findLatestTranscript(sess: TmuxSession): string | null {
    const dir = join(this.projectsRoot, encodeCwd(sess.cwd));
    if (!existsSync(dir)) return null;
    let best: { path: string; mtime: number } | null = null;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      const mtime = stat.mtimeMs;
      if (mtime < sess.startedAt - 5_000) continue; // 5s grace for clock skew
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
    if (best) {
      // Derive session ID from filename.
      const m = best.path.match(/([0-9a-f-]{36})\.jsonl$/);
      if (m) sess.sessionId = m[1];
      return best.path;
    }
    return null;
  }

  private processTranscriptLine(sess: TmuxSession, line: string): void {
    const adapted = adaptTranscriptLine(line);
    if (!adapted) return;

    // Capture session ID from any line that carries it (the first system
    // event arrives early and is the simplest source of truth).
    if (adapted.sessionId && !sess.sessionId) {
      sess.sessionId = adapted.sessionId;
    }

    const turn = sess.activeTurn;
    if (!turn) return;

    if (adapted.event) {
      turn.events.push(adapted.event);
      if (adapted.event.type === "assistant") {
        const text = extractAssistantText(adapted.event);
        if (text) turn.lastAssistantText = text;
      }
      for (const listener of turn.listeners) {
        try {
          listener(adapted.event);
        } catch (err) {
          console.warn("[tmux-driver] listener threw:", err);
        }
      }
    }

    if (adapted.turnDone) {
      const result: SpawnResult = {
        sessionId: sess.sessionId,
        response: turn.resultText || turn.lastAssistantText,
        events: turn.events,
        exitCode: 0,
        error: null,
      };
      // Only clear activeTurn if it's still the turn we captured at line 435.
      // A delayed `turn_duration` for an earlier (already-killed) turn must
      // not clobber the *next* turn that has since been assigned. The captured
      // `turn` variable is still resolvable — we keep the new activeTurn intact.
      if (sess.activeTurn === turn) {
        sess.activeTurn = null;
      }
      if (!turn.rejected) {
        turn.rejected = true;
        turn.resolve(result);
      }
    }
  }
}

function extractAssistantText(event: StreamEvent): string {
  if (event.type !== "assistant") return "";
  let text = "";
  for (const block of event.message.content) {
    if (block.type === "text" && block.text) text += block.text;
  }
  return text;
}

/**
 * Deterministic tmux session name for `(threadId, agentName)`. The manager
 * persists this string on the session row so `tmux has-session` checks
 * after a bot restart can find the existing tmux session.
 */
export function tmuxSessionNameFor(threadId: string, agentName: string): string {
  return computeSessionName(threadId, agentName);
}

function computeSessionName(threadId: string, agentName: string): string {
  // tmux session names can't contain '.', ':', or whitespace cleanly.
  const safeThread = threadId.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeAgent = agentName.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `junior-${safeThread}-${safeAgent}`;
  return name.length > SESSION_NAME_MAX ? name.slice(0, SESSION_NAME_MAX) : name;
}

function handleKey(threadId: string, agentName: string): string {
  return `${threadId}\x00${agentName}`;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf("\x00");
  return [key.slice(0, i), key.slice(i + 1)];
}

function encodeCwd(cwd: string): string {
  // Mirror Claude Code's encoding: '/' → '-', collapse leading slash.
  return cwd.replace(/\//g, "-");
}

function buildInteractiveClaudeArgs(input: DriverSendInput): string[] {
  // Lean on the existing arg builder but strip the `-p <prompt>` and
  // `--output-format` flags — those are headless-only.
  const all = buildClaudeArgs(input.session, /*prompt*/ "", input.config);
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const arg = all[i];
    if (arg === "-p") {
      i++; // skip the prompt arg
      continue;
    }
    if (arg === "--output-format" || arg === "--verbose") {
      if (arg === "--output-format") i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

async function defaultExec(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

async function execWithStdin(cmd: string, args: string[], stdin: string): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin: new Blob([stdin]).stream(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}
