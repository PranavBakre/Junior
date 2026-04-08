import type { SpawnHandle, SpawnResult } from "../claude/types.ts";

export function withTimeout(
  handle: SpawnHandle,
  timeoutMs: number,
  onTimeout?: () => void,
): SpawnHandle {
  let timedOut = false;

  const result = new Promise<SpawnResult>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
      onTimeout?.();
      resolve({
        sessionId: null,
        response: "",
        events: [],
        exitCode: null,
        error: `Process timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    handle.result.then((res) => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve(res);
      }
    });
  });

  return {
    result,
    onEvent: handle.onEvent,
    kill: handle.kill,
    pid: handle.pid,
  };
}
