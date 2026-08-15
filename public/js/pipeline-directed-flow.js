/* =================== static directed-flow renderer =================== */
function flowEscAttr(value) {
  return esc(value).replaceAll("'", "&#39;");
}

function pipelineFlowPath(edge, reply = false) {
  const from = reply ? edge.to : edge.from;
  const to = reply ? edge.from : edge.to;
  const x1 = reply ? from.x : from.x + from.width;
  const x2 = reply ? to.x + to.width : to.x;
  const laneOffset = reply ? 20 : -15;
  const y1 = from.y + from.height / 2 + laneOffset;
  const y2 = to.y + to.height / 2 + laneOffset;
  const bend = Math.max(48, Math.abs(x2 - x1) * 0.42);
  const c1 = reply ? x1 - bend : x1 + bend;
  const c2 = reply ? x2 + bend : x2 - bend;
  return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
}

function pipelineFlowNodeMarkup(node, run) {
  const selected = PIPE.selectedNodeId === node.id ? " on" : "";
  const color = pipelineColorCss(node.status);
  if (node.type === "run") {
    return '<button class="pipeline-flow-card run' + selected + '" type="button" data-flow-node="' +
      flowEscAttr(node.id) + '" style="left:' + node.x + 'px;top:' + node.y + 'px;--flow-color:' + color + '">' +
      '<span class="flow-card-top"><span class="flow-kind">start</span>' + pill(node.status) + '</span>' +
      '<strong>' + esc(node.title) + '</strong><span class="flow-phase">' + esc(node.subtitle) + '</span>' +
      '<span class="flow-card-meta">owner ' + esc(run.ownerAgent || "—") + '<br />' +
      (run.assignments || []).length + ' assignments · ' + pipelineDateTime(run.createdAt) + '</span></button>';
  }
  const assignment = node.assignment;
  return '<button class="pipeline-flow-card assignment' + selected + ' status-' + esc(node.status) +
    '" type="button" data-flow-node="' + flowEscAttr(node.id) + '" style="left:' + node.x +
    'px;top:' + node.y + 'px;--flow-color:' + color + '">' +
    '<span class="flow-card-top"><span class="flow-kind">assignment · ' + esc(shortId(node.id)) + '</span>' +
    pill(node.status) + '</span><strong class="flow-route">' + esc(node.title) + '</strong>' +
    '<span class="flow-reason"><span>reason</span>' + esc(clipPipelineText(node.subtitle, 112)) + '</span>' +
    '<span class="flow-reply' + (node.reply ? '' : ' empty') + '"><span>reply</span>' +
    esc(clipPipelineText(node.reply || "Waiting for agent reply.", 105)) + '</span>' +
    '<span class="flow-card-meta">' + esc(pipelineDateTime(assignment.createdAt)) +
    (assignment.parentAssignmentId ? ' · child dispatch' : '') + '</span></button>';
}

function renderPipelineFlow(run) {
  const graph = PIPE.graph;
  if (!graph) return;
  PIPE.world.style.width = graph.width + "px";
  PIPE.world.style.height = graph.height + "px";
  PIPE.nodeLayer.innerHTML = graph.nodes.map((node) => pipelineFlowNodeMarkup(node, run)).join("");

  const dispatchPaths = graph.edges.map((edge) => {
    const midX = (edge.from.x + edge.from.width + edge.to.x) / 2;
    const midY = (edge.from.y + edge.from.height / 2 + edge.to.y + edge.to.height / 2) / 2 - 28;
    const reason = "dispatch · " + clipPipelineText(edge.reason, 15);
    return '<path class="flow-dispatch status-' + esc(edge.status) + '" d="' +
      pipelineFlowPath(edge) + '" marker-end="url(#flow-arrow)" />' +
      '<g class="flow-edge-label" transform="translate(' + midX + ' ' + midY + ')">' +
      '<rect x="-70" y="-12" width="140" height="24" rx="7"></rect>' +
      '<text text-anchor="middle" dominant-baseline="central">' + esc(reason) + '</text></g>';
  }).join("");
  const replyPaths = graph.edges.filter((edge) => edge.reply).map((edge) =>
    '<path class="flow-reply-line" d="' + pipelineFlowPath(edge, true) +
    '" marker-end="url(#flow-reply-arrow)" />'
  ).join("");
  PIPE.svg.setAttribute("viewBox", `0 0 ${graph.width} ${graph.height}`);
  PIPE.svg.innerHTML = '<defs><marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"></path></marker>' +
    '<marker id="flow-reply-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"></path></marker></defs>' +
    '<g class="flow-dispatches">' + dispatchPaths + '</g><g class="flow-replies' +
    (PIPE.repliesOn ? '' : ' hidden') + '">' + replyPaths + '</g>';
  applyPipelineFlowTransform();
}

function buildPipelineScene(run, preserveCamera = false) {
  PIPE.graph = buildPipelineDirectedFlow(run);
  PIPE.nodes = PIPE.graph.nodes;
  PIPE.edges = PIPE.graph.edges;
  PIPE.byId = new Map(PIPE.nodes.map((node) => [node.id, node]));
  PIPE.runId = run.id;
  PIPE.signature = pipelineSignature(run);
  if (!PIPE.byId.has(PIPE.selectedNodeId) && !(run.assignments || []).some((item) => item.id === PIPE.selectedNodeId)) {
    PIPE.selectedNodeId = null;
  }
  renderPipelineFlow(run);
  $("pipeline-topology-title").textContent = (run.kind || "pipeline") + " · " + (run.phase || "—");
  $("pipeline-topology-meta").textContent = PIPE.graph.assignmentCount +
    " assignments · solid dispatches · dashed replies";
  $("pipeline-graph-stats").textContent = PIPE.graph.assignmentCount + " assignments · " +
    PIPE.graph.edges.length + " branches";
  setPipelineStatus(PIPE.graph.assignmentCount ? "" : "This run has no assignments yet.");
  if (!preserveCamera) requestAnimationFrame(() => resetPipelineCamera(false));
  paintPipelineDetail(run);
}

function clearPipelineScene() {
  PIPE.graph = null;
  PIPE.nodes = [];
  PIPE.edges = [];
  PIPE.byId = new Map();
  PIPE.runId = null;
  PIPE.signature = null;
  PIPE.svg.innerHTML = "";
  PIPE.nodeLayer.innerHTML = "";
  $("pipeline-graph-stats").textContent = "— assignments · — branches";
}

function applyPipelineFlowTransform() {
  PIPE.world.style.transform = `translate3d(${PIPE.view.x}px,${PIPE.view.y}px,0) scale(${PIPE.view.scale})`;
}

function resizePipeline() {
  if (PIPE.mode !== "topology" || !PIPE.graph) return;
  applyPipelineFlowTransform();
}

function fitPipeline() {
  if (!PIPE.graph) return;
  const rect = PIPE.viewport.getBoundingClientRect();
  const scale = Math.min(1, Math.max(0.34,
    Math.min((rect.width - 56) / PIPE.graph.width, (rect.height - 92) / PIPE.graph.height)));
  PIPE.view.scale = scale;
  PIPE.view.x = Math.round((rect.width - PIPE.graph.width * scale) / 2);
  PIPE.view.y = Math.round((rect.height - PIPE.graph.height * scale) / 2 + 22);
  applyPipelineFlowTransform();
}

function resetPipelineCamera() {
  const rect = PIPE.viewport.getBoundingClientRect();
  const root = PIPE.graph?.nodes[0];
  const scale = 0.86;
  PIPE.view = {
    x: root ? 32 - root.x * scale : 32,
    y: root ? rect.height / 2 - (root.y + root.height / 2) * scale : 84,
    scale,
  };
  applyPipelineFlowTransform();
}

function selectPipelineNode(id, center = false) {
  PIPE.selectedNodeId = id;
  for (const element of PIPE.nodeLayer.querySelectorAll("[data-flow-node]")) {
    element.classList.toggle("on", element.dataset.flowNode === id);
  }
  const run = pipelineDetails.get(selectedPipelineId);
  if (run) {
    paintPipelineDetail(run);
    if (PIPE.mode === "trace") renderPipelineTrace(run);
  }
  const node = PIPE.byId.get(id);
  if (center && node) {
    const rect = PIPE.viewport.getBoundingClientRect();
    PIPE.view.x = rect.width / 2 - (node.x + node.width / 2) * PIPE.view.scale;
    PIPE.view.y = rect.height / 2 - (node.y + node.height / 2) * PIPE.view.scale;
    applyPipelineFlowTransform();
  }
}

function invalidatePipeline() {}
function pipelineFrame() {}

PIPE.nodeLayer.addEventListener("click", (event) => {
  const card = event.target.closest("[data-flow-node]");
  if (card) selectPipelineNode(card.dataset.flowNode, false);
});

PIPE.viewport.addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-flow-node]")) return;
  PIPE.viewport.setPointerCapture(event.pointerId);
  PIPE.viewport.classList.add("dragging");
  PIPE.drag = { x: event.clientX, y: event.clientY };
});
PIPE.viewport.addEventListener("pointermove", (event) => {
  if (!PIPE.drag) return;
  PIPE.view.x += event.clientX - PIPE.drag.x;
  PIPE.view.y += event.clientY - PIPE.drag.y;
  PIPE.drag = { x: event.clientX, y: event.clientY };
  applyPipelineFlowTransform();
});
const endPipelineFlowDrag = () => {
  PIPE.drag = null;
  PIPE.viewport.classList.remove("dragging");
};
PIPE.viewport.addEventListener("pointerup", endPipelineFlowDrag);
PIPE.viewport.addEventListener("pointercancel", endPipelineFlowDrag);
PIPE.viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = PIPE.viewport.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const worldX = (mouseX - PIPE.view.x) / PIPE.view.scale;
  const worldY = (mouseY - PIPE.view.y) / PIPE.view.scale;
  const next = Math.max(0.3, Math.min(1.65, PIPE.view.scale * Math.exp(-event.deltaY * 0.0012)));
  PIPE.view.scale = next;
  PIPE.view.x = mouseX - worldX * next;
  PIPE.view.y = mouseY - worldY * next;
  applyPipelineFlowTransform();
}, { passive: false });

$("pipeline-replies").addEventListener("click", (event) => {
  PIPE.repliesOn = !PIPE.repliesOn;
  event.currentTarget.classList.toggle("on", PIPE.repliesOn);
  PIPE.svg.querySelector(".flow-replies")?.classList.toggle("hidden", !PIPE.repliesOn);
});
