/**
 * Injectable clock for controllers, leases, deadlines, polling, and tests.
 * Production uses `systemClock`; tests use `fakeClock`.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function fakeClock(start = 0): Clock & {
  advance(ms: number): void;
  set(ms: number): void;
} {
  let current = start;
  return {
    now: () => current,
    advance(ms: number): void {
      current += ms;
    },
    set(ms: number): void {
      current = ms;
    },
  };
}
