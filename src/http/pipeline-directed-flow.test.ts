import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

type FlowNode = { id: string; type: string; x: number; y: number; width: number; height: number };
type FlowEdge = { fromId: string; toId: string; reason: string; reply: string | null };
type LayoutHelpers = {
  buildPipelineDirectedFlow: (run: Record<string, unknown>) => {
    nodes: FlowNode[];
    edges: FlowEdge[];
    width: number;
    height: number;
    assignmentCount: number;
  };
};

async function loadLayout(): Promise<LayoutHelpers> {
  const source = await Bun.file(
    resolve(import.meta.dirname, "../../public/js/pipeline-directed-flow-layout.js"),
  ).text();
  return new Function(`${source}; return { buildPipelineDirectedFlow };`)() as LayoutHelpers;
}

describe("pipeline directed-flow layout", () => {
  it("lays causal assignments left-to-right and preserves explicit branches", async () => {
    const { buildPipelineDirectedFlow } = await loadLayout();
    const graph = buildPipelineDirectedFlow({
      id: "run-1",
      kind: "bug",
      phase: "review",
      status: "active",
      assignments: [
        { id: "a", sourceAgent: "default", targetAgent: "build", status: "completed", objective: "Implement", createdAt: 1 },
        { id: "b", sourceAgent: "build", targetAgent: "review", status: "leased", objective: "Review", createdAt: 2 },
        { id: "c", parentAssignmentId: "a", sourceAgent: "default", targetAgent: "reproducer", status: "waiting", objective: "Reproduce", createdAt: 3 },
      ],
    });
    expect(graph.assignmentCount).toBe(3);
    expect(graph.edges.map((edge) => [edge.fromId, edge.toId])).toEqual([
      ["run:run-1", "a"],
      ["a", "b"],
      ["a", "c"],
    ]);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      expect(byId.get(edge.toId)!.x).toBeGreaterThan(byId.get(edge.fromId)!.x);
    }
    expect(byId.get("b")!.y).not.toBe(byId.get("c")!.y);
  });

  it("is deterministic and prevents cards in one column from overlapping", async () => {
    const { buildPipelineDirectedFlow } = await loadLayout();
    const run = {
      id: "run-2",
      kind: "product",
      status: "active",
      assignments: [{
        id: "root-assignment",
        sourceAgent: "default",
        targetAgent: "build",
        status: "completed",
        createdAt: 1,
      }, ...Array.from({ length: 6 }, (_, index) => ({
        id: `child-${index}`,
        parentAssignmentId: "root-assignment",
        sourceAgent: "build",
        targetAgent: `agent-${index}`,
        status: "completed",
        createdAt: index + 2,
      }))],
    };
    const first = buildPipelineDirectedFlow(run);
    expect(first).toEqual(buildPipelineDirectedFlow(run));
    const columns = new Map<number, FlowNode[]>();
    for (const node of first.nodes) columns.set(node.x, [...(columns.get(node.x) || []), node]);
    for (const nodes of columns.values()) {
      const sorted = nodes.sort((a, b) => a.y - b.y);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index].y).toBeGreaterThanOrEqual(sorted[index - 1].y + sorted[index - 1].height);
      }
    }
  });
});

describe("pipeline trace and directed-flow markup", () => {
  it("defaults to the trace and keeps Option A as the secondary view", async () => {
    const html = await Bun.file(resolve(import.meta.dirname, "../../public/index.html")).text();
    const view = html.match(/id="view-pipelines"[\s\S]*?<\/section>/)?.[0] || "";
    expect(view).toContain('id="pipeline-trace"');
    expect(view).toContain('id="pipeline-flow-viewport"');
    expect(view).toContain("directed flow");
    expect(view).toContain("dashed lines");
    expect(view).not.toContain("drift");
    expect(html).toContain("pipeline-directed-flow-layout.js");
    expect(html).toContain("pipeline-directed-flow.js");
    expect(html).not.toContain("pipeline-agent-map-layout.js");

    const source = await Bun.file(resolve(import.meta.dirname, "../../public/js/pipeline-directed-flow.js")).text();
    expect(source).toContain("function pipelineFlowPath");
    expect(source).toContain("flow-dispatch");
    expect(source).toContain("flow-reply-line");
    expect(source).toContain("reason");
    expect(source).toContain("reply");
    expect(source).not.toContain("THREE");
  });
});
