/* =================== pipeline swimlane layout =================== */
var SWIMLANE_COLORS = {
  leased: "#4f8cff",
  pending: "#4f8cff",
  waiting: "#f59e0b",
  "needs-human": "#f59e0b",
  completed: "#22c55e",
  failed: "#ff3b3b",
  cancelled: "#666666",
  terminal: "#666666",
};
var TERMINAL_ASSIGNMENT = { completed: true, failed: true, cancelled: true };

function fallbackTs(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sortLaneKeys(names) {
  const unique = [];
  for (const name of names || []) {
    if (!unique.includes(name)) unique.push(name);
  }
  return unique.sort((a, b) => {
    const pa = a === "lead" ? 0 : a === "default" ? 1 : 2;
    const pb = b === "lead" ? 0 : b === "default" ? 1 : 2;
    if (pa !== pb) return pa - pb;
    return String(a).localeCompare(String(b));
  });
}

function swimlaneDomain(run, assignments, now) {
  const fallback = fallbackTs(run && run.createdAt, now);
  const starts = [fallback];
  const ends = [now];
  for (const assignment of assignments || []) {
    starts.push(fallbackTs(assignment.createdAt, fallback));
    ends.push(fallbackTs(assignment.updatedAt, fallback));
    if (assignment.leaseExpiresAt != null) {
      ends.push(fallbackTs(assignment.leaseExpiresAt, fallback));
    }
  }
  const start = Math.min(...starts);
  return { start, end: Math.max(...ends, start + 1) };
}

function assignmentBarRange(assignment, now, fallback) {
  const x0 = fallbackTs(assignment.createdAt, fallback);
  const x1 = TERMINAL_ASSIGNMENT[assignment.status]
    ? fallbackTs(assignment.updatedAt, fallback)
    : now;
  return { x0, x1: Math.max(x0, x1) };
}

function assignmentBarColor(status) {
  return SWIMLANE_COLORS[status] || "#999999";
}

function isUnleasedPending(assignment) {
  return assignment.status === "pending" && assignment.leaseOwner == null;
}

function phaseTapeCells(transitions, now, fallback) {
  const rows = (transitions || [])
    .map((item) => ({
      toPhase: item.toPhase,
      start: fallbackTs(item.occurredAt, fallback),
    }))
    .filter((item) => item.toPhase)
    .sort((a, b) => a.start - b.start || String(a.toPhase).localeCompare(String(b.toPhase)));
  return rows.map((item, index) => {
    const next = rows[index + 1];
    const end = next ? next.start : now;
    return {
      toPhase: item.toPhase,
      start: item.start,
      end: Math.max(end, item.start),
      duration: Math.max(0, end - item.start),
    };
  });
}

function assignmentBlockerKinds(assignment) {
  const kinds = [];
  for (const outcome of assignment.outcomes || []) {
    for (const blocker of outcome.blockers || []) {
      if (blocker && blocker.kind && !kinds.includes(blocker.kind)) kinds.push(blocker.kind);
    }
  }
  return kinds;
}

function groupAssignmentsByLane(assignments) {
  const groups = new Map();
  for (const assignment of assignments || []) {
    const key = assignment.targetAgent || "unknown";
    const list = groups.get(key) || [];
    list.push(assignment);
    groups.set(key, list);
  }
  return sortLaneKeys([...groups.keys()]).map((agent) => ({
    agent,
    assignments: groups.get(agent).slice().sort((a, b) =>
      fallbackTs(a.createdAt, 0) - fallbackTs(b.createdAt, 0)
    ),
  }));
}

function domainPercent(ts, domain) {
  const span = Math.max(1, domain.end - domain.start);
  return ((ts - domain.start) / span) * 100;
}
