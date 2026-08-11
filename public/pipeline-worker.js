"use strict";

function buildLayout(input) {
  const runNodeId = "run:" + input.runId;
  const assignments = [...input.assignments].sort((a, b) =>
    a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
  const assignmentIds = new Set(assignments.map((assignment) => assignment.id));
  const agents = [...new Set(assignments.map((assignment) => assignment.targetAgent))];
  const laneByAgent = new Map(agents.map((agent, index) => [agent, index]));
  const latestByAgent = new Map();
  const depthById = new Map([[runNodeId, 0]]);
  const occupiedLaneSlots = new Set();
  const laneGap = input.vertical ? 3.25 : 1.95;
  const laneHeight = Math.max(0, (agents.length - 1) * laneGap);
  const nodes = [{
    id: runNodeId,
    type: "run",
    depth: 0,
    fromId: null,
    x: 0,
    y: input.vertical ? 0 : laneHeight / 2 + 2.15,
    z: 0,
  }];

  for (const assignment of assignments) {
    const explicitParent = assignment.parentAssignmentId &&
        assignmentIds.has(assignment.parentAssignmentId)
      ? assignment.parentAssignmentId
      : null;
    const inferredParent = latestByAgent.get(assignment.sourceAgent) || null;
    const fromId = explicitParent || inferredParent || runNodeId;
    const lane = laneByAgent.get(assignment.targetAgent) || 0;
    let depth = (depthById.get(fromId) || 0) + 1;
    while (occupiedLaneSlots.has(lane + ":" + depth)) depth += 1;
    occupiedLaneSlots.add(lane + ":" + depth);
    nodes.push({
      id: assignment.id,
      type: "assignment",
      depth,
      fromId,
      x: input.vertical ? 0 : depth * 4,
      y: input.vertical ? -depth * 1.8 : laneHeight / 2 - lane * laneGap,
      z: Math.sin((lane + 1) * 1.7) * 0.34,
    });
    depthById.set(assignment.id, depth);
    latestByAgent.set(assignment.targetAgent, assignment.id);
  }

  if (input.vertical) {
    const columns = new Map();
    for (const node of nodes) {
      const column = columns.get(node.depth);
      if (column) column.push(node);
      else columns.set(node.depth, [node]);
    }
    for (const [depth, column] of columns) {
      column.sort((a, b) => a.id.localeCompare(b.id));
      const total = (column.length - 1) * 3.25;
      column.forEach((node, index) => {
        node.x = total / 2 - index * 3.25;
        node.y = -depth * 1.8;
        node.z = column.length > 1
          ? (index - (column.length - 1) / 2) * 0.72
          : Math.sin(depth * 0.75) * 0.14;
      });
    }
  }

  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  return {
    nodes,
    agents,
    bounds: {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    },
  };
}

self.onmessage = (event) => {
  const { id, input } = event.data || {};
  if (!id || !input) return;
  try {
    self.postMessage({ id, result: buildLayout(input) });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
