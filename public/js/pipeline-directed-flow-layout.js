/* =============== deterministic 2D directed pipeline flow =============== */
function buildPipelineDirectedFlow(run) {
  const cardWidth = 268;
  const cardHeight = 154;
  const columnGap = 160;
  const rowGap = 42;
  const marginX = 72;
  const marginY = 150;
  const rootId = "run:" + run.id;
  const assignments = [...(run.assignments || [])].sort((a, b) =>
    (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id))
  );
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const order = new Map(assignments.map((assignment, index) => [assignment.id, index]));
  const parentById = new Map();

  for (const assignment of assignments) {
    let parentId = byId.has(assignment.parentAssignmentId) && assignment.parentAssignmentId !== assignment.id
      ? assignment.parentAssignmentId
      : null;
    if (!parentId) {
      const currentIndex = order.get(assignment.id);
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const candidate = assignments[index];
        if (candidate.targetAgent === (assignment.sourceAgent || "system")) {
          parentId = candidate.id;
          break;
        }
      }
    }
    parentById.set(assignment.id, parentId || rootId);
  }

  for (const assignment of assignments) {
    const seen = new Set([assignment.id]);
    let cursor = parentById.get(assignment.id);
    while (cursor && cursor !== rootId) {
      if (seen.has(cursor)) {
        parentById.set(assignment.id, rootId);
        break;
      }
      seen.add(cursor);
      cursor = parentById.get(cursor);
    }
  }

  const children = new Map([[rootId, []]]);
  for (const assignment of assignments) children.set(assignment.id, []);
  for (const assignment of assignments) {
    const parentId = children.has(parentById.get(assignment.id)) ? parentById.get(assignment.id) : rootId;
    parentById.set(assignment.id, parentId);
    children.get(parentId).push(assignment.id);
  }

  const depthById = new Map([[rootId, 0]]);
  const setDepth = (id, depth) => {
    depthById.set(id, depth);
    for (const childId of children.get(id) || []) setDepth(childId, depth + 1);
  };
  setDepth(rootId, 0);

  let nextLeaf = 0;
  const rowById = new Map();
  const placeRows = (id) => {
    const childIds = children.get(id) || [];
    if (!childIds.length) {
      const row = nextLeaf;
      nextLeaf += 1;
      rowById.set(id, row);
      return row;
    }
    const rows = childIds.map(placeRows);
    const row = rows.reduce((sum, value) => sum + value, 0) / rows.length;
    rowById.set(id, row);
    return row;
  };
  placeRows(rootId);

  const nodes = [{
    id: rootId,
    type: "run",
    status: run.status,
    title: run.kind + " pipeline",
    subtitle: run.phase,
    x: marginX,
    y: marginY + rowById.get(rootId) * (cardHeight + rowGap),
    width: cardWidth,
    height: cardHeight,
  }, ...assignments.map((assignment) => {
    const outcome = assignment.outcomes?.[assignment.outcomes.length - 1] || null;
    return {
      id: assignment.id,
      type: "assignment",
      status: assignment.status,
      title: (assignment.sourceAgent || "system") + " → " + (assignment.targetAgent || "unknown"),
      subtitle: assignment.objective || "No dispatch reason recorded.",
      reply: outcome?.reason || null,
      replyStatus: outcome?.status || null,
      assignment,
      x: marginX + depthById.get(assignment.id) * (cardWidth + columnGap),
      y: marginY + rowById.get(assignment.id) * (cardHeight + rowGap),
      width: cardWidth,
      height: cardHeight,
    };
  })];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = assignments.map((assignment) => {
    const fromId = parentById.get(assignment.id);
    return {
      id: "dispatch:" + assignment.id,
      fromId,
      toId: assignment.id,
      from: nodeById.get(fromId),
      to: nodeById.get(assignment.id),
      reason: assignment.objective || "No dispatch reason recorded.",
      status: assignment.status,
      reply: assignment.outcomes?.[assignment.outcomes.length - 1]?.reason || null,
    };
  });
  const maxRight = Math.max(...nodes.map((node) => node.x + node.width));
  const maxBottom = Math.max(...nodes.map((node) => node.y + node.height));
  return {
    nodes,
    edges,
    width: maxRight + marginX,
    height: Math.max(600, maxBottom + 72),
    assignmentCount: assignments.length,
  };
}
