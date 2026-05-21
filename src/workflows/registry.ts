import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RepoConfig } from "../config.ts";
import { log } from "../logger.ts";
import {
  OVERLAY_WORKFLOW_ROOT,
  PUBLIC_WORKFLOW_ROOT,
  type WorkflowDefinition,
  type WorkflowSourceRoot,
  type WorkflowValidationError,
} from "./types.ts";
import { loadWorkflowDefinition } from "./definition.ts";

export interface WorkflowRegistrySnapshot {
  definitions: Map<string, WorkflowDefinition>;
  errors: WorkflowValidationError[];
}

export interface WorkflowRegistryOptions {
  repos: RepoConfig[];
  roots?: Array<{ path: string; sourceRoot: WorkflowSourceRoot }>;
  builtInCommands?: Set<string>;
  debounceMs?: number;
}

export type WorkflowRegistryEvent =
  | { type: "reloaded"; snapshot: WorkflowRegistrySnapshot }
  | { type: "watch-error"; error: Error };

export class WorkflowRegistry {
  private roots: Array<{ path: string; sourceRoot: WorkflowSourceRoot }>;
  private repos: RepoConfig[];
  private builtInCommands: Set<string>;
  private debounceMs: number;
  private definitions = new Map<string, WorkflowDefinition>();
  private errors: WorkflowValidationError[] = [];
  private listeners: Array<(event: WorkflowRegistryEvent) => void> = [];
  private watchers: FSWatcher[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WorkflowRegistryOptions) {
    this.roots = options.roots ?? [
      { path: PUBLIC_WORKFLOW_ROOT, sourceRoot: "public" },
      { path: OVERLAY_WORKFLOW_ROOT, sourceRoot: "overlay" },
    ];
    this.repos = options.repos;
    this.builtInCommands = options.builtInCommands ?? new Set();
    this.debounceMs = options.debounceMs ?? 350;
  }

  onEvent(listener: (event: WorkflowRegistryEvent) => void): void {
    this.listeners.push(listener);
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.definitions.get(name);
  }

  all(): WorkflowDefinition[] {
    return [...this.definitions.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  getErrors(): WorkflowValidationError[] {
    return [...this.errors];
  }

  snapshot(): WorkflowRegistrySnapshot {
    return {
      definitions: new Map(this.definitions),
      errors: this.getErrors(),
    };
  }

  async reload(): Promise<WorkflowRegistrySnapshot> {
    const previous = this.definitions;
    const loadedByRoot = new Map<WorkflowSourceRoot, Map<string, WorkflowDefinition>>();
    const errors: WorkflowValidationError[] = [];

    for (const root of this.roots) {
      const byName = new Map<string, WorkflowDefinition>();
      const files = await workflowFiles(root.path);
      for (const file of files) {
        try {
          const definition = await loadWorkflowDefinition({
            path: join(root.path, file),
            sourceRoot: root.sourceRoot,
            repos: this.repos,
            builtInCommands: this.builtInCommands,
          });
          if (definition) byName.set(definition.name, definition);
        } catch (err) {
          errors.push({
            path: join(root.path, file),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      loadedByRoot.set(root.sourceRoot, byName);
    }

    const next = new Map<string, WorkflowDefinition>();
    for (const definition of loadedByRoot.get("public")?.values() ?? []) {
      next.set(definition.name, definition);
    }
    for (const definition of loadedByRoot.get("overlay")?.values() ?? []) {
      next.set(definition.name, definition);
    }

    // Last-known-good: invalid changed files do not evict previous active
    // definitions. Invalid overlays also fail closed on cold boot by blocking
    // the public definition with the same filename stem.
    for (const error of errors) {
      const previousDefinition = [...previous.values()].find(
        (definition) => definition.sourcePath === error.path,
      );
      if (previousDefinition) {
        next.set(previousDefinition.name, previousDefinition);
        continue;
      }

      const sourceRoot = sourceRootForPath(error.path, this.roots);
      if (sourceRoot === "overlay") {
        next.delete(workflowNameFromFilePath(error.path));
      }
    }

    this.definitions = next;
    this.errors = errors;
    const snapshot = this.snapshot();
    this.emit({ type: "reloaded", snapshot });
    return snapshot;
  }

  async startWatching(): Promise<void> {
    await this.reload();
    for (const root of this.roots) {
      try {
        const watcher = watch(root.path, () => {
          this.scheduleReload();
        });
        watcher.on("error", (error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          log.warn("workflow", `watch error root=${root.path}: ${err.message}`);
          this.emit({ type: "watch-error", error: err });
        });
        this.watchers.push(watcher);
        log.info("workflow", `watching ${root.path}`);
      } catch (err) {
        // Missing roots are allowed. Log at info to make diagnosis possible.
        log.info(
          "workflow",
          `watch skipped root=${root.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  stopWatching(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reload().catch((err) => {
        log.warn(
          "workflow",
          `reload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.debounceMs);
  }

  private emit(event: WorkflowRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(
          "workflow",
          `registry listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function sourceRootForPath(
  path: string,
  roots: Array<{ path: string; sourceRoot: WorkflowSourceRoot }>,
): WorkflowSourceRoot | undefined {
  return roots.find((root) => path.startsWith(`${root.path}/`))?.sourceRoot;
}

function workflowNameFromFilePath(path: string): string {
  const filename = basename(path);
  return filename.endsWith(".workflow.md")
    ? filename.slice(0, -".workflow.md".length)
    : filename;
}

async function workflowFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
