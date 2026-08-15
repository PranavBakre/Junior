/* =================== pipeline trace + directed flow =================== */
const PIPELINE_COLORS = {
  active: 0x4f8cff, pending: 0x4f8cff, leased: 0x4f8cff,
  completed: 0x22c55e, delivered: 0x22c55e,
  waiting: 0xf59e0b, "needs-human": 0xf59e0b,
  failed: 0xff3b3b, dead: 0xff3b3b,
  cancelled: 0x666666, terminal: 0x999999,
};

const PIPE = {
  mode: "trace",
  viewport: $("pipeline-flow-viewport"),
  world: $("pipeline-flow-world"),
  svg: $("pipeline-flow-links"),
  nodeLayer: $("pipeline-flow-nodes"),
  graph: null,
  nodes: [],
  edges: [],
  byId: new Map(),
  runId: null,
  signature: null,
  selectedNodeId: null,
  view: { x: 0, y: 0, scale: 1 },
  drag: null,
  repliesOn: true,
};

const pipelineColor = (status) => PIPELINE_COLORS[status] || 0x999999;
const pipelineColorCss = (status) => "#" + pipelineColor(status).toString(16).padStart(6, "0");
const clipPipelineText = (value, max) => {
  const text = value == null ? "" : String(value);
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};

function pipelineEmptyCopy() {
  const copy = "No typed pipeline runs. Default-kind durability is hidden unless you enable it.";
  return pipelineRuntimeMode === "off" ? copy + " Pipeline controllers are off." : copy;
}

function isUnleasedPending(assignment) {
  return assignment.status === "pending" && assignment.leaseOwner == null;
}

function assignmentBlockerKinds(assignment) {
  const kinds = [];
  for (const outcome of assignment.outcomes || []) {
    for (const blocker of outcome.blockers || []) {
      if (blocker?.kind && !kinds.includes(blocker.kind)) kinds.push(blocker.kind);
    }
  }
  return kinds;
}

function pipelineSignature(run) {
  return JSON.stringify([
    run.id, run.phase, run.status, run.stateVersion,
    (run.assignments || []).map((assignment) => [
      assignment.id, assignment.parentAssignmentId, assignment.status,
      assignment.updatedAt, assignment.dispatch?.status, assignment.dispatch?.attempts,
    ]),
  ]);
}

function pipelineDateTime(timestamp) {
  if (timestamp == null) return "—";
  return new Date(timestamp).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function pipelineDuration(start, end) {
  if (start == null || end == null) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h " + (minutes % 60) + "m";
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
}

function assignmentTiming(assignment) {
  const latestOutcome = assignment.outcomes?.[assignment.outcomes.length - 1] || null;
  const start = assignment.dispatch?.deliveredAt || assignment.createdAt;
  const ended = ["completed", "failed", "cancelled"].includes(assignment.status);
  const end = latestOutcome?.createdAt || (ended ? assignment.updatedAt : null);
  return { start, end, latestOutcome };
}

function renderPipelineTrace(run) {
  const assignments = [...(run.assignments || [])].sort((a, b) =>
    (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id))
  );
  const terminal = run.status === "terminal";
  const finishTime = terminal ? run.updatedAt : null;
  const completed = assignments.filter((assignment) => assignment.status === "completed").length;
  const cards = assignments.map((assignment, index) => {
    const { start, end, latestOutcome } = assignmentTiming(assignment);
    const replyCount = assignment.outcomes?.length || 0;
    const reply = latestOutcome?.reason || "No reply recorded yet.";
    const replyMeta = latestOutcome
      ? esc(latestOutcome.action) + " · " + esc(latestOutcome.status) + " · " + pipelineDateTime(latestOutcome.createdAt)
      : "waiting for agent outcome";
    return '<div class="trace-step" data-trace-assignment="' + esc(assignment.id) + '">' +
      '<div class="trace-node" style="border-color:' + pipelineColorCss(assignment.status) +
      ';color:' + pipelineColorCss(assignment.status) + '">' + String(index + 1).padStart(2, "0") + "</div>" +
      '<button class="trace-step-card' + (PIPE.selectedNodeId === assignment.id ? " on" : "") +
      '" type="button" data-select-assignment="' + esc(assignment.id) + '">' +
      '<div class="trace-step-top"><span class="trace-agent">' + esc(assignment.sourceAgent || "system") +
      ' <span class="trace-arrow">→</span> ' + esc(assignment.targetAgent || "unknown") + "</span>" +
      pill(assignment.status) + '<span class="trace-id">' + esc(shortId(assignment.id)) + "</span></div>" +
      '<div class="trace-times"><div class="trace-time"><span class="trace-label">start</span><strong>' +
      esc(pipelineDateTime(start)) + '</strong></div><div class="trace-time"><span class="trace-label">end</span><strong>' +
      esc(end ? pipelineDateTime(end) : "In progress") + '</strong></div><div class="trace-time"><span class="trace-label">duration</span><strong>' +
      esc(pipelineDuration(start, end || Date.now())) + (end ? "" : " so far") + "</strong></div></div>" +
      '<div class="trace-copy"><div><span class="trace-label">reason for dispatch</span><p>' +
      esc(assignment.objective || "No dispatch reason recorded.") + '</p></div><div class="trace-reply' +
      (latestOutcome ? "" : " empty") + '"><span class="trace-label">' +
      (replyCount > 1 ? "latest reply · " + replyCount + " outcomes" : "reply") + "</span><p>" +
      esc(reply) + '</p><div class="trace-reply-meta">' + replyMeta + "</div></div></div></button></div>";
  }).join("");
  const endTitle = terminal
    ? "Pipeline ended · " + (run.terminalOutcome || run.status)
    : "Pipeline is still running";
  const endMeta = terminal
    ? pipelineDateTime(finishTime) + " · total " + pipelineDuration(run.createdAt, finishTime)
    : "current phase " + (run.phase || "—") + " · updated " + ago(run.updatedAt) + " ago";
  $("pipeline-trace").innerHTML =
    '<div class="trace-overview"><div class="trace-overview-main"><div class="trace-kicker">' +
    esc(run.kind) + ' pipeline</div><div class="trace-overview-title">' + esc(run.phase) +
    '</div><div class="trace-overview-sub">' + esc(run.ownerAgent) + " owns this run · " +
    assignments.length + " dispatches</div></div>" +
    '<div class="trace-stat"><span class="trace-label">status</span><strong>' + esc(run.status) +
    '</strong></div><div class="trace-stat"><span class="trace-label">started</span><strong>' +
    esc(pipelineDateTime(run.createdAt)) + '</strong></div><div class="trace-stat"><span class="trace-label">progress</span><strong>' +
    completed + " / " + assignments.length + " complete</strong></div></div>" +
    '<div class="trace-list"><div class="trace-boundary start"><div class="trace-node">S</div>' +
    '<div class="trace-boundary-copy"><strong>Pipeline started</strong><span>' +
    esc(pipelineDateTime(run.createdAt)) + " · initiated by " + esc(run.ownerAgent || "system") +
    "</span></div></div>" +
    (cards || '<div class="empty">No assignments have been dispatched yet.</div>') +
    '<div class="trace-boundary end"><div class="trace-node">' + (terminal ? "E" : "…") +
    '</div><div class="trace-boundary-copy"><strong>' + esc(endTitle) + '</strong><span>' +
    esc(endMeta) + "</span></div></div></div>";
}

function setPipelineMode(mode) {
  PIPE.mode = mode === "topology" ? "topology" : "trace";
  const topology = PIPE.mode === "topology";
  $("pipeline-trace").hidden = topology;
  $("pipeline-topology").hidden = !topology;
  $("pipeline-mode-trace").classList.toggle("on", !topology);
  $("pipeline-mode-topology").classList.toggle("on", topology);
  $("pipeline-mode-trace").setAttribute("aria-selected", String(!topology));
  $("pipeline-mode-topology").setAttribute("aria-selected", String(topology));
  const run = pipelineDetails.get(selectedPipelineId);
  if (!run) return;
  if (topology) {
    const signature = pipelineSignature(run);
    if (PIPE.runId !== run.id || PIPE.signature !== signature || !PIPE.graph) {
      buildPipelineScene(run, PIPE.runId === run.id);
    } else {
      resizePipeline();
      invalidatePipeline();
    }
  } else {
    renderPipelineTrace(run);
    paintPipelineDetail(run);
  }
}

function pipelineInCurrentFilter(runId) {
  return pipelines.some((run) => run.id === runId);
}

function pipelineInCurrentList(runId) {
  return pipelineInCurrentFilter(runId);
}

function selectedPipelineSummary() {
  if (!selectedPipelineId) return null;
  return pipelines.find((run) => run.id === selectedPipelineId)
    || attentionPipelines.find((run) => run.id === selectedPipelineId)
    || pipelineDetails.get(selectedPipelineId)
    || { id: selectedPipelineId };
}

function pipelineSummaryFor(id) {
  if (!id) return null;
  return pipelines.find((run) => run.id === id)
    || attentionPipelines.find((run) => run.id === id)
    || pipelineDetails.get(id)
    || null;
}

function renderPipelineRunRow(run, extras) {
  const detail = pipelineDetails.get(run.id);
  const open = (detail?.assignments || []).filter((assignment) =>
    ["pending", "leased", "waiting"].includes(assignment.status)
  ).length;
  return '<div class="pipeline-run' + (run.id === selectedPipelineId ? " on" : "") +
    '" data-pipeline-id="' + esc(run.id) + '">' +
    '<div class="top"><span class="name">' + esc(run.kind || "run") + " · " + esc(shortId(run.id)) +
    '</span><span class="count">' +
    (extras?.badge ? esc(extras.badge) : (detail ? open + " open" : esc(run.status || "—"))) +
    "</span></div>" +
    '<div class="phase">' +
    (extras?.phase
      ? esc(extras.phase)
      : esc(run.phase || "—") + " · " + esc(run.status || "—") + " · " + ago(run.updatedAt) + " ago") +
    "</div></div>";
}

function renderPipelines() {
  $("pipeline-count").textContent = pipelines.length + " runs";
  if (!selectedPipelineId) {
    selectedPipelineId = pipelines[0]?.id || null;
    PIPE.selectedNodeId = null;
  }
  const inList = pipelineInCurrentList(selectedPipelineId);
  const listSignature = selectedPipelineId + "|" + (inList ? "in" : "out") + "|" +
    pipelines.map((run) => {
      const detail = pipelineDetails.get(run.id);
      return [run.id, run.phase, run.status, run.updatedAt, detail?.updatedAt || 0].join(":");
    }).join("|");
  if (listSignature !== renderedPipelineListSignature) {
    renderedPipelineListSignature = listSignature;
    let rows = pipelines.map((run) => renderPipelineRunRow(run)).join("");
    if (selectedPipelineId && !inList) {
      const pinned = pipelineSummaryFor(selectedPipelineId) || { id: selectedPipelineId };
      rows = renderPipelineRunRow(pinned, {
        badge: "not in filter",
        phase: "run not in current filter",
      }) + rows;
    }
    $("pipeline-runs").innerHTML = rows || '<div class="empty">' +
      (pipelineFetchError ? "Failed to load pipelines." : esc(pipelineEmptyCopy())) + "</div>";
  }

  const summary = selectedPipelineSummary();
  if (!summary) {
    $("pipeline-summary").innerHTML =
      '<div class="eyebrow">control plane</div><div class="title">No typed runs</div>' +
      '<div class="meta">' + esc(pipelineEmptyCopy()) + "</div>";
    $("pipeline-detail").style.display = "none";
    $("pipeline-detail").closest(".pipeline-rail")?.classList.remove("detail-open");
    setPipelineStatus(pipelineFetchError ? "Failed to load pipeline control plane." : "");
    clearPipelineScene();
    return;
  }

  const run = pipelineDetails.get(summary.id);
  if (!run) {
    paintPipelineSummary(summary);
    if (PIPE.runId !== summary.id) clearPipelineScene();
    if (currentView() === "pipelines") void loadPipelineDetail(summary.id);
    return;
  }
  if (currentView() !== "pipelines") {
    paintPipelineDetail(run);
    return;
  }
  if (PIPE.mode === "trace") {
    renderPipelineTrace(run);
    paintPipelineDetail(run);
    return;
  }
  const signature = pipelineSignature(run);
  if (PIPE.runId !== run.id || PIPE.signature !== signature || !PIPE.graph) {
    buildPipelineScene(run, PIPE.runId === run.id);
  } else {
    paintPipelineDetail(run);
    invalidatePipeline();
  }
}

function pipelineSpendMeta(run) {
  const spend = (run && run.spend) || pipelineSpendById.get(run && run.id);
  return spend ? "<br />spend " + esc(formatSpendSummary(spend)) : "";
}

function paintPipelineSummary(run) {
  const offList = run.id && !pipelineInCurrentList(run.id);
  $("pipeline-summary").innerHTML =
    '<div class="eyebrow">' + esc(run.kind || "pipeline") + " · " + esc(run.status || "loading") + "</div>" +
    '<div class="title">' + esc(run.phase || "Loading flow") + "</div>" +
    '<div class="meta">owner ' + esc(run.ownerAgent || "—") + "<br />thread " +
    esc(shortId(run.threadId || run.id)) +
    (run.repoRefs?.length ? "<br />repos " + esc(run.repoRefs.join(", ")) : "") +
    pipelineSpendMeta(run) + (offList ? "<br />run not in current filter" : "") + "</div>";
  $("pipeline-detail").style.display = "none";
  $("pipeline-detail").closest(".pipeline-rail")?.classList.remove("detail-open");
  if (pipelineDetailErrors.has(run.id)) {
    setPipelineStatus(
      'Failed to load run. <button class="ctrl retry" type="button" data-retry-pipeline>Retry</button>',
      true,
    );
  } else {
    setPipelineStatus(pipelineDetailLoadingId === run.id
      ? "Loading selected pipeline…"
      : "Loading its directed flow…");
  }
}

async function loadPipelineDetail(runId, force = false) {
  if (!runId || pipelineDetailLoadingId === runId) return;
  if (!force && (pipelineDetailErrors.has(runId) || pipelineDetails.has(runId))) return;
  pipelineDetailAbortController?.abort();
  const controller = new AbortController();
  pipelineDetailAbortController = controller;
  pipelineDetailErrors.delete(runId);
  pipelineDetailLoadingId = runId;
  const summary = pipelines.find((candidate) => candidate.id === runId)
    || attentionPipelines.find((candidate) => candidate.id === runId)
    || { id: runId };
  if (selectedPipelineId === runId) paintPipelineSummary(summary);
  const response = await safeFetch("/api/pipelines/" + encodeURIComponent(runId), {
    signal: controller.signal,
  });
  if (controller.signal.aborted) return;
  if (pipelineDetailAbortController === controller) pipelineDetailAbortController = null;
  if (pipelineDetailLoadingId === runId) pipelineDetailLoadingId = null;
  const stillSelected = selectedPipelineId === runId;
  if (response.ok && response.data.pipeline) {
    pipelineDetails.delete(runId);
    pipelineDetails.set(runId, response.data.pipeline);
    while (pipelineDetails.size > 4) {
      const oldestId = pipelineDetails.keys().next().value;
      if (oldestId === selectedPipelineId) {
        const selected = pipelineDetails.get(oldestId);
        pipelineDetails.delete(oldestId);
        pipelineDetails.set(oldestId, selected);
        continue;
      }
      pipelineDetails.delete(oldestId);
    }
  } else if (stillSelected) {
    pipelineDetailErrors.add(runId);
    setPipelineStatus(
      'Failed to load run. <button class="ctrl retry" type="button" data-retry-pipeline>Retry</button>',
      true,
    );
  }
  if (stillSelected) renderPipelines();
}

function paintPipelineDetail(run) {
  const open = (run.assignments || []).filter((assignment) =>
    ["pending", "leased", "waiting"].includes(assignment.status)
  ).length;
  const transitions = (run.transitions || []).slice(-4);
  $("pipeline-summary").innerHTML =
    '<div class="eyebrow">' + esc(run.kind) + " · " + esc(run.status) + "</div>" +
    '<div class="title">' + esc(run.phase) + "</div>" +
    '<div class="meta">owner ' + esc(run.ownerAgent) + " · " +
    (run.assignments || []).length + " dispatches · " + open + " open<br />" +
    "thread " + esc(shortId(run.threadId)) +
    (run.repoRefs?.length ? "<br />repos " + esc(run.repoRefs.join(", ")) : "") +
    pipelineSpendMeta(run) +
    (pipelineInCurrentList(run.id) ? "" : "<br />run not in current filter") +
    (transitions.length ? "<br />phase trail " + esc(transitions.map((item) => item.toPhase).join(" → ")) : "") +
    (run.slackPermalink ? '<br /><a class="tlink" href="' + esc(run.slackPermalink) +
      '" target="_blank" rel="noreferrer">open in Slack</a>' : "") + "</div>";
  setPipelineStatus("");

  const selectedAssignment = (run.assignments || []).find(
    (assignment) => assignment.id === PIPE.selectedNodeId,
  );
  const detail = $("pipeline-detail");
  const rail = detail.closest(".pipeline-rail");
  if (!selectedAssignment) {
    if (PIPE.selectedNodeId === "run:" + run.id) {
      rail.classList.remove("detail-open");
      detail.style.display = "";
      detail.innerHTML =
        '<button class="rail-close" type="button" data-close-assignment>close</button>' +
        '<div class="eyebrow">selected run</div><div class="objective">' + esc(run.kind) +
        " pipeline is " + esc(run.status) + " in " + esc(run.phase) + ".</div>" +
        '<div class="meta">created ' + ago(run.createdAt) + " ago<br />updated " + ago(run.updatedAt) +
        " ago<br />state version " + esc(run.stateVersion) + "</div>";
      return;
    }
    rail.classList.remove("detail-open");
    detail.style.display = "none";
    detail.innerHTML = "";
    return;
  }
  rail.classList.add("detail-open");
  detail.style.display = "";
  detail.innerHTML = renderAssignmentRail(run, selectedAssignment);
}

function renderAssignmentRail(run, assignment) {
  const unleased = isUnleasedPending(assignment);
  const lease = unleased
    ? "unleased"
    : (assignment.leaseOwner || "—") +
      (assignment.leaseExpiresAt != null ? " · expires " + fmtNext(assignment.leaseExpiresAt) : "");
  const dispatch = assignment.dispatch
    ? assignment.dispatch.status +
      (assignment.dispatch.attempts != null ? " · " + assignment.dispatch.attempts + " attempts" : "") +
      (assignment.dispatch.eventType ? " · " + assignment.dispatch.eventType : "") +
      (assignment.dispatch.lastError ? " · " + assignment.dispatch.lastError : "")
    : "none";
  const outcomes = assignment.outcomes || [];
  const artifacts = assignment.artifactRefs || [];
  const readable = new Map((run.artifacts || []).map((item) => [item.ref, item.readable]));
  const gates = run.gates || [];
  return '<button class="rail-close" type="button" data-close-assignment>close</button>' +
    '<div class="eyebrow">assignment · ' + esc(assignment.targetAgent) + "</div>" +
    pill(assignment.status) +
    '<div class="objective">' + esc(assignment.objective || "—") + "</div>" +
    '<div class="meta">' + esc(assignment.sourceAgent) + " → " + esc(assignment.targetAgent) +
    (assignment.deadlineAt != null ? "<br />deadline " + esc(fmtNext(assignment.deadlineAt)) : "") +
    (assignmentBlockerKinds(assignment).length
      ? "<br />blockers " + esc(assignmentBlockerKinds(assignment).join(", ")) : "") + "</div>" +
    '<div class="rail-section"><div class="lbl">lease</div><div class="meta">' + esc(lease) + "</div></div>" +
    '<div class="rail-section"><div class="lbl">dispatch</div><div class="meta">' + esc(dispatch) + "</div></div>" +
    '<div class="rail-section"><div class="lbl">outcomes</div>' +
    (outcomes.length ? outcomes.map((outcome) => {
      const blockers = (outcome.blockers || []).map((blocker) => blocker.kind).join(", ");
      const checks = (outcome.checks || []).map((check) => check.name + ":" + check.status).join(", ");
      return '<div class="rail-item"><div class="meta">' + esc(outcome.action) + " · " +
        esc(outcome.status) + '</div><div class="objective">' + esc(outcome.reason || "") + "</div>" +
        (blockers ? '<div class="meta">blockers ' + esc(blockers) + "</div>" : "") +
        (checks ? '<div class="meta">checks ' + esc(checks) + "</div>" : "") + "</div>";
    }).join("") : '<div class="meta">none</div>') + "</div>" +
    '<div class="rail-section"><div class="lbl">artifacts</div>' +
    (artifacts.length ? artifacts.map((ref) => '<div class="meta">' + esc(ref) +
      (readable.get(ref) === false ? " · unread" : "") + "</div>").join("") : '<div class="meta">none</div>') +
    "</div>" +
    '<div class="rail-section"><div class="lbl">gates</div>' +
    (gates.length ? gates.map((gate) => '<div class="rail-item"><div class="meta">' +
      esc(gate.gateKind) + " · " + esc(gate.status) +
      (gate.agentName ? " · " + esc(gate.agentName) : "") + "</div></div>").join("") :
      '<div class="meta">none</div>') + "</div>";
}

function setPipelineStatus(content, html = false) {
  const status = $("pipeline-status");
  if (html) status.innerHTML = content;
  else status.textContent = content || "";
  status.style.display = content ? "" : "none";
}

async function loadPipelineSpend() {
  const generation = ++pipelineSpendGeneration;
  const from = Date.now() - 89 * 24 * 60 * 60 * 1000;
  const response = await safeFetch("/api/spend?from=" + from + "&groupBy=pipeline");
  if (generation !== pipelineSpendGeneration || !response.ok) return;
  const next = new Map();
  for (const bucket of response.data.buckets || []) next.set(bucket.key, bucket);
  pipelineSpendById = next;
  if (currentView() === "pipelines") renderPipelines();
}

$("pipeline-runs").addEventListener("click", (event) => {
  const row = event.target.closest("[data-pipeline-id]");
  if (!row || selectedPipelineId === row.dataset.pipelineId) return;
  pipelineDetailAbortController?.abort();
  pipelineDetailAbortController = null;
  pipelineDetailLoadingId = null;
  selectedPipelineId = row.dataset.pipelineId;
  PIPE.selectedNodeId = null;
  pipelineDetailErrors.delete(selectedPipelineId);
  renderPipelines();
});

$("pipeline-trace").addEventListener("click", (event) => {
  const card = event.target.closest("[data-select-assignment]");
  if (!card) return;
  selectPipelineNode(card.dataset.selectAssignment, false);
  const run = pipelineDetails.get(selectedPipelineId);
  if (run) renderPipelineTrace(run);
});

$("pipeline-mode-trace").addEventListener("click", () => setPipelineMode("trace"));
$("pipeline-mode-topology").addEventListener("click", () => setPipelineMode("topology"));

$("pipeline-detail").addEventListener("click", (event) => {
  if (!event.target.closest("[data-close-assignment]")) return;
  selectPipelineNode(null, false);
  const run = pipelineDetails.get(selectedPipelineId);
  if (run && PIPE.mode === "trace") renderPipelineTrace(run);
});

$("pipeline-filter").addEventListener("change", () => refreshPipelineControlPlane());
$("pipeline-kind").addEventListener("change", () => refreshPipelineControlPlane());
$("pipeline-include-default").addEventListener("change", () => refreshPipelineControlPlane());
$("pipeline-refresh").addEventListener("click", () => {
  if (selectedPipelineId) {
    pipelineDetails.delete(selectedPipelineId);
    pipelineDetailErrors.delete(selectedPipelineId);
  }
  refreshPipelineControlPlane();
});
$("pipeline-fit").addEventListener("click", () => {
  fitPipeline(true);
});
$("pipeline-reset").addEventListener("click", () => {
  resetPipelineCamera(true);
});
$("pipeline-status").addEventListener("click", (event) => {
  if (!event.target.closest("[data-retry-pipeline]") || !selectedPipelineId) return;
  pipelineDetails.delete(selectedPipelineId);
  pipelineDetailErrors.delete(selectedPipelineId);
  void loadPipelineDetail(selectedPipelineId, true);
});



if (window.ResizeObserver) new ResizeObserver(() => resizePipeline()).observe($("pipeline-stage"));
