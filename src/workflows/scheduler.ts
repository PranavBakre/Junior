import { CronExpressionParser } from "cron-parser";
import { log } from "../logger.ts";
import type { WorkflowExecutor } from "./executor.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { WorkflowStore } from "./store.ts";
import type {
  WorkflowDefinition,
  WorkflowRunReason,
  WorkflowScheduleTrigger,
  WorkflowState,
} from "./types.ts";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface WorkflowSchedulerOptions {
  registry: WorkflowRegistry;
  store: WorkflowStore;
  executor: WorkflowExecutor;
  now?: () => Date;
}

export class WorkflowScheduler {
  private registry: WorkflowRegistry;
  private store: WorkflowStore;
  private executor: WorkflowExecutor;
  private now: () => Date;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();

  constructor(options: WorkflowSchedulerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
    this.registry.onEvent((event) => {
      if (event.type === "reloaded") {
        this.reconcile(event.snapshot).catch((err) => {
          log.warn("workflow", `scheduler reconcile failed: ${formatError(err)}`);
        });
      }
    });
  }

  async reconcile(snapshot = this.registry.snapshot()): Promise<void> {
    const seen = new Set<string>();
    for (const definition of snapshot.definitions.values()) {
      seen.add(definition.name);
      await this.ensureState(definition);
      await this.schedule(definition);
    }

    for (const [name, timer] of this.timers) {
      if (seen.has(name)) continue;
      clearTimeout(timer);
      this.timers.delete(name);
    }
  }

  async runNow(options: {
    name: string;
    reason: WorkflowRunReason;
    actorSlackUserId?: string | null;
  }): Promise<{ summary: string; runId: string }> {
    const definition = this.registry.get(options.name);
    if (!definition) throw new Error(`Unknown workflow: ${options.name}`);
    if (!definition.enabled) {
      throw new Error(`Workflow ${definition.name} is disabled in its workflow file.`);
    }
    const state = await this.ensureState(definition);
    if (state.status === "invalid") {
      throw new Error(`Workflow ${definition.name} is invalid and cannot run.`);
    }
    if (state.status === "stopped" && options.reason !== "manual") {
      throw new Error(`Workflow ${definition.name} is stopped. Use !workflow start ${definition.name} to resume triggers.`);
    }
    if (!this.tryClaimRun(definition)) {
      await this.markSkipped(state, "Workflow already running.");
      return { summary: `Skipped *${definition.name}*: already running.`, runId: "" };
    }
    try {
      const result = await this.executor.run({
        definition,
        reason: options.reason,
        actorSlackUserId: options.actorSlackUserId ?? null,
      });
      await this.schedule(definition);
      return { summary: result.summary, runId: result.run.id };
    } finally {
      this.releaseRun(definition);
    }
  }

  async stopWorkflow(name: string): Promise<void> {
    const definition = this.registry.get(name);
    const state = definition
      ? await this.ensureState(definition)
      : await this.store.getState(name);
    if (!state) throw new Error(`Unknown workflow: ${name}`);
    await this.store.setState({ ...state, status: "stopped", nextRunAt: null });
    this.cancel(name);
  }

  async startWorkflow(name: string): Promise<void> {
    const definition = this.registry.get(name);
    if (!definition) throw new Error(`Unknown workflow: ${name}`);
    if (!definition.enabled) {
      throw new Error(`Workflow ${name} is disabled in its workflow file. Change enabled to true before starting it.`);
    }
    const state = await this.ensureState(definition);
    await this.store.setState({
      ...state,
      status: "active",
      activeVersionHash: definition.versionHash,
      sourcePath: definition.sourcePath,
      lastLoadedAt: this.now().getTime(),
      lastError: null,
    });
    await this.schedule(definition);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.executor.terminateActiveRuns();
  }

  private async schedule(definition: WorkflowDefinition): Promise<void> {
    this.cancel(definition.name);
    const state = await this.ensureState(definition);
    if (!definition.enabled || state.status !== "active") {
      await this.store.setState({ ...state, nextRunAt: null });
      return;
    }

    const next = nextScheduledRun(definition, this.now());
    if (!next) {
      await this.store.setState({ ...state, nextRunAt: null });
      return;
    }

    const delay = Math.max(0, next.getTime() - this.now().getTime());
    const timer = setTimeout(() => {
      this.timers.delete(definition.name);
      const currentDelay = Math.max(0, next.getTime() - this.now().getTime());
      if (currentDelay > 0) {
        this.schedule(definition).catch((err) => {
          log.warn("workflow", `continuation schedule failed workflow=${definition.name}: ${formatError(err)}`);
        });
        return;
      }
      this.handleScheduledRun(definition.name).catch((err) => {
        log.warn("workflow", `scheduled run failed workflow=${definition.name}: ${formatError(err)}`);
      });
    }, timerDelayFor(delay));
    this.timers.set(definition.name, timer);
    await this.store.setState({ ...state, nextRunAt: next.getTime() });
  }

  private async handleScheduledRun(name: string): Promise<void> {
    const definition = this.registry.get(name);
    if (!definition) return;
    const state = await this.ensureState(definition);
    if (!definition.enabled || state.status !== "active") {
      await this.schedule(definition);
      return;
    }
    if (!this.tryClaimRun(definition)) {
      await this.markSkipped(state, "Scheduled run overlapped an active run.");
      await this.schedule(definition);
      return;
    }
    try {
      await this.executor.run({
        definition,
        reason: "schedule",
        actorSlackUserId: null,
      });
    } catch (err) {
      const latest = await this.store.getState(definition.name);
      if (latest) {
        await this.store.setState({
          ...latest,
          lastError: formatError(err),
          lastRunStatus: "failed",
          lastRunAt: this.now().getTime(),
        });
      }
    } finally {
      this.releaseRun(definition);
    }
    await this.schedule(definition);
  }

  private async ensureState(definition: WorkflowDefinition): Promise<WorkflowState> {
    const existing = await this.store.getState(definition.name);
    const now = this.now().getTime();
    const base: WorkflowState = {
      name: definition.name,
      status: definition.enabled ? "active" : "stopped",
      activeVersionHash: definition.versionHash,
      sourcePath: definition.sourcePath,
      lastLoadedAt: now,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
    };
    if (!existing) {
      await this.store.setState(base);
      return base;
    }

    const status = definition.enabled ? existing.status : "stopped";
    const next = {
      ...existing,
      status,
      activeVersionHash: definition.versionHash,
      sourcePath: definition.sourcePath,
      lastLoadedAt: now,
    };
    if (
      next.status !== existing.status ||
      next.activeVersionHash !== existing.activeVersionHash ||
      next.sourcePath !== existing.sourcePath
    ) {
      await this.store.setState(next);
    }
    return next;
  }

  private async markSkipped(state: WorkflowState, message: string): Promise<void> {
    await this.store.setState({
      ...state,
      lastRunAt: this.now().getTime(),
      lastRunStatus: "skipped",
      lastError: message,
    });
  }

  private cancel(name: string): void {
    const timer = this.timers.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(name);
  }

  private tryClaimRun(definition: WorkflowDefinition): boolean {
    if (definition.concurrency === "parallel") return true;
    if (this.running.has(definition.name)) return false;
    this.running.add(definition.name);
    return true;
  }

  private releaseRun(definition: WorkflowDefinition): void {
    if (definition.concurrency === "skip") {
      this.running.delete(definition.name);
    }
  }
}

export function nextScheduledRun(
  definition: WorkflowDefinition,
  now = new Date(),
): Date | null {
  const candidates = definition.triggers
    .filter((trigger): trigger is WorkflowScheduleTrigger => trigger.type === "schedule")
    .map((trigger) =>
      CronExpressionParser.parse(trigger.cron, {
        tz: trigger.timezone,
        currentDate: now,
      }).next().toDate(),
    )
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

export function timerDelayFor(delayMs: number): number {
  return Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
