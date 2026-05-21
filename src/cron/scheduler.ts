import { log } from "../logger.ts";

export interface DailyCronOptions {
  name: string;
  dailyAt: string;
  runOnStartup?: boolean;
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  run: () => Promise<void>;
}

export interface StartedCron {
  stop: () => void;
}

export function startDailyCron(options: DailyCronOptions): StartedCron {
  const now = options.now ?? (() => new Date());
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const execute = async () => {
    if (stopped) return;
    if (running) {
      log.warn("cron", `${options.name} skipped; previous run still active`);
      scheduleNext();
      return;
    }

    running = true;
    try {
      await options.run();
    } catch (err) {
      log.error(
        "cron",
        `${options.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const delayMs = msUntilNextDailyRun(now(), options.dailyAt);
    timer = setTimeoutFn(execute, delayMs);
    log.info("cron", `${options.name} scheduled in ${Math.round(delayMs / 1000)}s`);
  };

  if (options.runOnStartup) {
    void execute();
  } else {
    scheduleNext();
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
    },
  };
}

export function msUntilNextDailyRun(now: Date, dailyAt: string): number {
  const [hour, minute] = dailyAt.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}
