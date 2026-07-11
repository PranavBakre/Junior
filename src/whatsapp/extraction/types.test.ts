import { describe, expect, test } from "bun:test";
import {
  parseExtractionOutput,
  validateOps,
  type TaskOp,
} from "./types.ts";

describe("validateOps (per-op, not per-batch)", () => {
  test("keeps well-formed ops of every kind", () => {
    const ops = validateOps([
      { op: "create", task: "Build the API", owner: "Alice", priority: "p0" },
      { op: "update", id: "t1", status: "in-progress" },
      { op: "complete", id: "t2", note: "shipped" },
    ]);
    expect(ops).toHaveLength(3);
    expect(ops.map((o) => o.op)).toEqual(["create", "update", "complete"]);
  });

  test("drops an unknown op but keeps the rest of the batch", () => {
    const ops = validateOps([
      { op: "create", task: "keep me" },
      { op: "delete", id: "t9" }, // unknown op kind
      { op: "complete", id: "t3" },
    ]);
    expect(ops.map((o) => o.op)).toEqual(["create", "complete"]);
  });

  test("drops an op with an invalid priority enum, keeps siblings", () => {
    const ops = validateOps([
      { op: "create", task: "good", priority: "p1" },
      { op: "create", task: "bad", priority: "p5" }, // invalid enum
    ]);
    expect(ops).toHaveLength(1);
    expect((ops[0] as Extract<TaskOp, { op: "create" }>).task).toBe("good");
  });

  test("drops an op with an invalid status enum", () => {
    const ops = validateOps([
      { op: "update", id: "t1", status: "wip" }, // invalid enum
      { op: "update", id: "t2", status: "blocked" },
    ]);
    expect(ops).toHaveLength(1);
    expect((ops[0] as Extract<TaskOp, { op: "update" }>).id).toBe("t2");
  });

  test("drops a create with an empty/missing task and an update/complete missing id", () => {
    const ops = validateOps([
      { op: "create", task: "" }, // empty task
      { op: "create" }, // missing task
      { op: "update" }, // missing id
      { op: "complete" }, // missing id
      { op: "create", task: "survivor" },
    ]);
    expect(ops).toHaveLength(1);
    expect((ops[0] as Extract<TaskOp, { op: "create" }>).task).toBe("survivor");
  });

  test("drops non-object entries", () => {
    const ops = validateOps([null, "nope", 42, { op: "complete", id: "t1" }]);
    expect(ops).toHaveLength(1);
  });
});

describe("parseExtractionOutput", () => {
  test("parses a clean envelope", () => {
    const ops = parseExtractionOutput(
      '{"ops":[{"op":"create","task":"do the thing","priority":"p2"}]}',
    );
    expect(ops).toHaveLength(1);
  });

  test("tolerates surrounding prose / code fences and extracts the object", () => {
    const raw =
      'Here you go:\n```json\n{"ops":[{"op":"complete","id":"t1"}]}\n```\nDone.';
    const ops = parseExtractionOutput(raw);
    expect(ops).toEqual([{ op: "complete", id: "t1" }]);
  });

  test("empty ops is the normal no-op case, not a failure", () => {
    expect(parseExtractionOutput('{"ops":[]}')).toEqual([]);
  });

  test("a valid envelope with one bad op keeps the rest (batch survives)", () => {
    const ops = parseExtractionOutput(
      '{"ops":[{"op":"create","task":"keep"},{"op":"nope"},{"op":"create","task":"bad","priority":"pX"}]}',
    );
    expect(ops).toHaveLength(1);
    expect((ops[0] as Extract<TaskOp, { op: "create" }>).task).toBe("keep");
  });

  test("throws on non-JSON garbage (structural failure -> leave unprocessed)", () => {
    expect(() => parseExtractionOutput("not json at all")).toThrow();
  });

  test("throws on unparseable JSON", () => {
    expect(() => parseExtractionOutput('{"ops": [')).toThrow();
  });

  test("throws when ops is missing", () => {
    expect(() => parseExtractionOutput("{}")).toThrow(/ops/);
  });

  test("throws when ops is not an array", () => {
    expect(() => parseExtractionOutput('{"ops":"nope"}')).toThrow(/array/);
  });
});
