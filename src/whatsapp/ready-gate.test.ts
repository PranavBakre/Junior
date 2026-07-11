import { describe, expect, test } from "bun:test";
import { createReadyGate } from "./ingest.ts";

describe("createReadyGate", () => {
  test("queues batches pushed before open()", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.push("a");
    gate.push("b");
    // Nothing processed until the gate opens.
    expect(seen).toEqual([]);
  });

  test("flushes queued batches in arrival order on open()", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.push("a");
    gate.push("b");
    gate.push("c");
    gate.open();

    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("processes batches directly after open()", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.open();
    gate.push("x");
    gate.push("y");

    expect(seen).toEqual(["x", "y"]);
  });

  test("preserves order across the open() boundary", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.push("before-1");
    gate.push("before-2");
    gate.open(); // flush the two buffered
    gate.push("after-1"); // direct

    expect(seen).toEqual(["before-1", "before-2", "after-1"]);
  });

  test("open() is idempotent — a second call neither replays nor re-flushes", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.push("a");
    gate.open();
    gate.open(); // no-op
    gate.push("b");
    gate.open(); // no-op

    expect(seen).toEqual(["a", "b"]);
  });

  test("open() with an empty queue is a no-op that still switches to direct mode", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.open();
    expect(seen).toEqual([]);
    gate.push("z");
    expect(seen).toEqual(["z"]);
  });

  test("close() buffers subsequent pushes again until the next open()", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.open();
    gate.push("live-1"); // direct while open
    expect(seen).toEqual(["live-1"]);

    gate.close(); // reconnect: re-gate
    gate.push("reconnect-1"); // buffered again
    gate.push("reconnect-2");
    expect(seen).toEqual(["live-1"]); // nothing new processed while closed

    gate.open(); // map refreshed — flush in arrival order
    expect(seen).toEqual(["live-1", "reconnect-1", "reconnect-2"]);
  });

  test("a close→open cycle flushes only what arrived after the close, in order", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.push("backfill-1");
    gate.open(); // flush backfill
    gate.push("live-1"); // direct
    gate.close();
    gate.push("post-1");
    gate.push("post-2");
    gate.open();

    // backfill + live already processed once; only post-* replay after reopen.
    expect(seen).toEqual(["backfill-1", "live-1", "post-1", "post-2"]);
  });

  test("open() stays idempotent across a reconnect that never closed the gate", () => {
    const seen: string[] = [];
    const gate = createReadyGate<string>((b) => seen.push(b));

    gate.push("a");
    gate.open();
    gate.open(); // a stray reconnect open() with no intervening close — no replay
    gate.push("b");
    expect(seen).toEqual(["a", "b"]);
  });

  test("a re-entrant push() during flush is handled directly, not double-flushed", () => {
    const seen: string[] = [];
    let reentered = false;
    const gate = createReadyGate<string>((b) => {
      seen.push(b);
      // Simulate a synchronous re-entrant push while draining the queue.
      if (b === "a" && !reentered) {
        reentered = true;
        gate.push("reentrant");
      }
    });

    gate.push("a");
    gate.push("b");
    gate.open();

    // "a" flushes, pushes "reentrant" (processed directly since already open),
    // then "b" flushes — each exactly once.
    expect(seen).toEqual(["a", "reentrant", "b"]);
  });
});
