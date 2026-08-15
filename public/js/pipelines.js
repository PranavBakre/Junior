/* =================== pipeline dispatch map =================== */
const PIPELINE_COLORS = {
  active: 0x4f8cff, pending: 0x4f8cff, leased: 0x4f8cff,
  completed: 0x22c55e, delivered: 0x22c55e,
  waiting: 0xf59e0b, "needs-human": 0xf59e0b,
  failed: 0xff3b3b, dead: 0xff3b3b,
  cancelled: 0x666666, terminal: 0x999999,
};
const PIPE = {
  canvas: $("pipeline-canvas"), renderer: null, scene: null, camera: null,
  group: null, nodeElements: [], nodePositions: new Map(),
  nodeLayer: $("pipeline-node-layer"), nodesNeedProject: false,
  packets: [], selectedNodeId: null,
  runId: null, signature: null, layoutMode: null,
  lastFrameAt: 0, needsRender: true, frameRequest: null,
  worker: null, layoutRequestId: 0, layoutResolvers: new Map(),
  buildGeneration: 0, buildingSignature: null,
  width: 1, height: 1, target: new THREE.Vector3(),
  yaw: 0, pitch: 0, distance: 14, desiredDistance: 14,
  drag: null,
};
const pipelineColor = (status) => PIPELINE_COLORS[status] || 0x999999;

function ensurePipelineRenderer() {
  if (PIPE.renderer) return;
  PIPE.renderer = new THREE.WebGLRenderer({
    canvas: PIPE.canvas, antialias: true, alpha: true, powerPreference: "high-performance",
  });
  const firefox = navigator.userAgent.includes("Firefox/");
  PIPE.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, firefox ? 1 : 1.25));
  PIPE.renderer.outputColorSpace = THREE.SRGBColorSpace;
  PIPE.renderer.shadowMap.enabled = false;
  PIPE.scene = new THREE.Scene();
  PIPE.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  updatePipelineCamera();
}

function ensurePipelineWorker() {
  if (PIPE.worker) return PIPE.worker;
  const worker = new Worker("/assets/pipeline-worker.js");
  worker.addEventListener("message", (event) => {
    const pending = PIPE.layoutResolvers.get(event.data?.id);
    if (!pending) return;
    PIPE.layoutResolvers.delete(event.data.id);
    if (event.data.error) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data.result);
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Pipeline layout worker failed");
    for (const pending of PIPE.layoutResolvers.values()) pending.reject(error);
    PIPE.layoutResolvers.clear();
    PIPE.worker = null;
  });
  PIPE.worker = worker;
  return worker;
}

function requestPipelineLayout(run) {
  const id = ++PIPE.layoutRequestId;
  const input = {
    runId: run.id,
    vertical: PIPE.width < 600,
    assignments: (run.assignments || []).map((assignment) => ({
      id: assignment.id,
      parentAssignmentId: assignment.parentAssignmentId,
      sourceAgent: assignment.sourceAgent,
      targetAgent: assignment.targetAgent,
      createdAt: assignment.createdAt,
    })),
  };
  return new Promise((resolve, reject) => {
    PIPE.layoutResolvers.set(id, { resolve, reject });
    ensurePipelineWorker().postMessage({ id, input });
  });
}

function disposePipelineObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      if (material.map) material.map.dispose();
      material.dispose();
    }
  });
}

function makePipelineCardElement(node, selected) {
  const color = "#" + pipelineColor(node.status).toString(16).padStart(6, "0");
  const element = document.createElement("button");
  element.type = "button";
  element.className = "pipeline-node-card" + (selected ? " selected" : "");
  element.dataset.pipelineNodeId = node.id;
  element.style.setProperty("--node-color", color);
  element.innerHTML =
    '<span class="node-title">' + esc(node.title) + "</span>" +
    '<span class="node-status">' + esc(String(node.status).toUpperCase()) + "</span>" +
    '<span class="node-subtitle">' + esc(node.subtitle || "") + "</span>" +
    '<span class="node-meta">' + esc(node.meta || "") + "</span>";
  return element;
}

function makePipelineLaneLabel(agent) {
  const canvas = document.createElement("canvas");
  canvas.width = 420;
  canvas.height = 80;
  const ctx = canvas.getContext("2d");
  ctx.font = "600 28px 'DM Mono', ui-monospace, monospace";
  ctx.fillStyle = "rgba(130,172,255,.9)";
  ctx.fillText(String(agent).toUpperCase() + " LANE", 12, 48);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 0.4),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  return label;
}

function addPipelineSwimlanes(nodes, positions) {
  if (PIPE.width < 600) return;
  const assignmentNodes = nodes.filter((node) => node.type === "assignment");
  const agents = [...new Set(assignmentNodes.map((node) => node.assignment.targetAgent))];
  const xValues = [...positions.values()].map((position) => position.x);
  const minX = Math.min(...xValues) - 1.8;
  const maxX = Math.max(...xValues) + 1.8;
  const width = maxX - minX;
  for (const agent of agents) {
    const node = assignmentNodes.find((candidate) => candidate.assignment.targetAgent === agent);
    const y = positions.get(node.id).y;
    const band = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 1.55),
      new THREE.MeshBasicMaterial({
        color: 0x4f8cff,
        transparent: true,
        opacity: 0.035,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    band.position.set((minX + maxX) / 2, y, -0.5);
    PIPE.group.add(band);
    const borderGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(minX, y - 0.78, -0.47),
      new THREE.Vector3(maxX, y - 0.78, -0.47),
      new THREE.Vector3(minX, y + 0.78, -0.47),
      new THREE.Vector3(maxX, y + 0.78, -0.47),
    ]);
    PIPE.group.add(new THREE.LineSegments(
      borderGeometry,
      new THREE.LineBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.15 }),
    ));
    const label = makePipelineLaneLabel(agent);
    label.position.set(minX + 1.1, y + 0.57, -0.42);
    PIPE.group.add(label);
  }
}

function addPipelineSurface(positions) {
  const values = [...positions.values()];
  if (!values.length) return;
  const minX = Math.min(...values.map((position) => position.x)) - 5;
  const maxX = Math.max(...values.map((position) => position.x)) + 5;
  const minY = Math.min(...values.map((position) => position.y)) - 4;
  const maxY = Math.max(...values.map((position) => position.y)) + 4;
  const width = Math.max(18, maxX - minX);
  const height = Math.max(14, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      color: 0x030407,
    }),
  );
  surface.position.set(centerX, centerY, -0.72);
  PIPE.group.add(surface);

  const grid = [];
  const step = width > 120 ? 2 : 1;
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    grid.push(x, minY, -0.68, x, maxY, -0.68);
  }
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) {
    grid.push(minX, y, -0.68, maxX, y, -0.68);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
  PIPE.group.add(new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0x27354f, transparent: true, opacity: 0.16 }),
  ));
}

function pipelineNodeFromAssignment(run, assignment, layoutNode) {
  if (!assignment) {
    return {
      ...layoutNode,
      type: "run",
      run,
      title: run.kind + " pipeline",
      subtitle: run.phase,
      meta: run.ownerAgent + " · v" + run.stateVersion,
      status: run.status,
    };
  }
  return {
    ...layoutNode,
    type: "assignment",
    assignment,
    title: assignment.targetAgent,
    subtitle: assignment.objective,
    meta: assignment.sourceAgent + " → " + assignment.targetAgent,
    status: assignment.status,
  };
}

function nextPipelineBuildFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function buildPipelineItems(items, generation, perFrame, build) {
  let index = 0;
  while (index < items.length) {
    await nextPipelineBuildFrame();
    if (generation !== PIPE.buildGeneration) return false;
    const deadline = performance.now() + 7;
    let built = 0;
    while (
      index < items.length &&
      built < perFrame &&
      (built === 0 || performance.now() < deadline)
    ) {
      build(items[index]);
      index += 1;
      built += 1;
    }
  }
  return true;
}

function frameLargePipeline(layout) {
  const { minX, maxX, minY, maxY } = layout.bounds;
  PIPE.target.set(
    minX + Math.min(16, Math.max(0, (maxX - minX) / 2)),
    (minY + maxY) / 2,
    0,
  );
  PIPE.yaw = -0.18;
  PIPE.pitch = 0.1;
  PIPE.desiredDistance = Math.min(30, Math.max(18, (maxY - minY) * 1.35));
  PIPE.distance = PIPE.desiredDistance;
  updatePipelineCamera();
  invalidatePipeline();
}

async function buildPipelineScene(run, preserveCamera = false) {
  const signature = pipelineSignature(run);
  const generation = ++PIPE.buildGeneration;
  PIPE.buildingSignature = signature;
  $("pipeline-status").textContent =
    (run.assignments || []).length > 24
      ? "Laying out large pipeline off the main thread…"
      : "Laying out pipeline…";
  ensurePipelineRenderer();
  let layout;
  try {
    layout = await requestPipelineLayout(run);
  } catch (error) {
    if (generation === PIPE.buildGeneration) {
      PIPE.buildingSignature = null;
      $("pipeline-status").textContent = "Failed to lay out pipeline: " + error.message;
    }
    return;
  }
  if (generation !== PIPE.buildGeneration) return;
  if (PIPE.group) {
    PIPE.scene.remove(PIPE.group);
    disposePipelineObject(PIPE.group);
  }
  PIPE.group = new THREE.Group();
  PIPE.scene.add(PIPE.group);
  PIPE.nodeElements = [];
  PIPE.nodeLayer.style.visibility = "hidden";
  PIPE.nodeLayer.replaceChildren();
  PIPE.packets = [];
  PIPE.runId = run.id;
  PIPE.layoutMode = PIPE.width < 600 ? "vertical" : "horizontal";
  const assignments = new Map(
    (run.assignments || []).map((assignment) => [assignment.id, assignment]),
  );
  const nodes = layout.nodes.map((node) =>
    pipelineNodeFromAssignment(run, assignments.get(node.id), node)
  );
  const positions = new Map(
    layout.nodes.map((node) => [node.id, new THREE.Vector3(node.x, node.y, node.z)]),
  );
  PIPE.nodePositions = positions;
  addPipelineSurface(positions);
  addPipelineSwimlanes(nodes, positions);
  const nodesBuilt = await buildPipelineItems(nodes, generation, 12, (node) => {
    const element = makePipelineCardElement(node, PIPE.selectedNodeId === node.id);
    PIPE.nodeLayer.append(element);
    PIPE.nodeElements.push(element);
  });
  if (!nodesBuilt) return;
  const edgeNodes = nodes.filter((node) => node.type === "assignment");
  const edgesBuilt = await buildPipelineItems(edgeNodes, generation, 10, (node) => {
    addPipelineEdge(
      positions.get(node.fromId),
      positions.get(node.id),
      node.assignment,
    );
  });
  if (!edgesBuilt) return;
  PIPE.signature = signature;
  PIPE.buildingSignature = null;
  if (!preserveCamera) {
    if (nodes.length > 24 && PIPE.width >= 600) frameLargePipeline(layout);
    else fitPipeline();
  }
  PIPE.nodeLayer.style.visibility = "";
  PIPE.nodesNeedProject = true;
  invalidatePipeline();
  paintPipelineDetail(run);
  $("pipeline-status").textContent = "";
}

function clearPipelineScene() {
  PIPE.buildGeneration += 1;
  PIPE.buildingSignature = null;
  if (!PIPE.group) return;
  PIPE.scene.remove(PIPE.group);
  disposePipelineObject(PIPE.group);
  PIPE.group = null;
  PIPE.nodeElements = [];
  PIPE.nodePositions = new Map();
  PIPE.nodeLayer.replaceChildren();
  PIPE.nodeLayer.style.visibility = "";
  PIPE.packets = [];
  PIPE.runId = null;
  PIPE.signature = null;
  invalidatePipeline();
}

function addPipelineEdge(from, to, assignment) {
  if (!from || !to) return;
  const vertical = PIPE.width < 600;
  const start = from.clone().add(vertical
    ? new THREE.Vector3(0, -0.61, -0.02)
    : new THREE.Vector3(1.48, 0, -0.02));
  const end = to.clone().add(vertical
    ? new THREE.Vector3(0, 0.61, -0.02)
    : new THREE.Vector3(-1.48, 0, -0.02));
  const mid = start.clone().lerp(end, 0.5);
  if (vertical) mid.x += (end.x - start.x) * 0.08;
  else mid.y += (end.y - start.y) * 0.08;
  const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
  const color = pipelineColor(assignment.dispatch?.status || assignment.status);
  PIPE.group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(20)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: assignment.dispatch ? 0.62 : 0.28 }),
  ));
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.1, 0.28, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  arrow.position.copy(curve.getPoint(0.95));
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(0.95).normalize());
  PIPE.group.add(arrow);
  if (["pending", "leased"].includes(assignment.dispatch?.status)) {
    const packet = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 8, 6),
      new THREE.MeshBasicMaterial({ color }),
    );
    PIPE.group.add(packet);
    PIPE.packets.push({
      mesh: packet, curve, offset: hashUnit(assignment.id),
      speed: 0.18,
    });
  }
}

function hashUnit(value) {
  let hash = 0;
  for (const char of String(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash % 1000) / 1000;
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

function renderPipelines() {
  $("pipeline-count").textContent = pipelines.length + " runs";
  if (!pipelines.some((run) => run.id === selectedPipelineId)) {
    selectedPipelineId = pipelines[0]?.id || null;
    PIPE.selectedNodeId = null;
  }
  const listSignature = selectedPipelineId + "|" + pipelines.map((run) => {
    const detail = pipelineDetails.get(run.id);
    return [run.id, run.phase, run.status, run.updatedAt, detail?.updatedAt || 0].join(":");
  }).join("|");
  if (listSignature !== renderedPipelineListSignature) {
    renderedPipelineListSignature = listSignature;
    $("pipeline-runs").innerHTML = pipelines.length
      ? pipelines.map((run) => {
        const detail = pipelineDetails.get(run.id);
        const open = (detail?.assignments || []).filter((assignment) =>
          ["pending", "leased", "waiting"].includes(assignment.status)
        ).length;
        return '<div class="pipeline-run' + (run.id === selectedPipelineId ? " on" : "") +
          '" data-pipeline-id="' + esc(run.id) + '">' +
          '<div class="top"><span class="name">' + esc(run.kind) + " · " + esc(shortId(run.id)) +
          '</span><span class="count">' +
          (detail ? open + " open" : esc(run.status)) + "</span></div>" +
          '<div class="phase">' + esc(run.phase) + " · " + esc(run.status) + " · " + ago(run.updatedAt) + " ago</div></div>";
        }).join("")
      : '<div class="empty">' +
        (pipelineFetchError ? "Failed to load pipelines." : "No pipeline runs yet. Agent dispatches will appear here.") +
        "</div>";
  }
  const summary = pipelines.find((candidate) => candidate.id === selectedPipelineId);
  if (!summary) {
    $("pipeline-summary").innerHTML =
      '<div class="eyebrow">control plane</div><div class="title">No pipeline runs</div>' +
      '<div class="meta">Start a durable agent pipeline to see its dispatch graph.</div>';
    $("pipeline-detail").style.display = "none";
    $("pipeline-status").textContent = pipelineFetchError
      ? "Failed to load pipeline control plane." : "No pipeline dispatches to map yet.";
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
  const signature = pipelineSignature(run);
  if (PIPE.runId !== run.id || !PIPE.group) {
    if (PIPE.buildingSignature !== signature) void buildPipelineScene(run);
  } else if (PIPE.signature !== signature) {
    if (PIPE.buildingSignature !== signature) void buildPipelineScene(run, true);
  }
  else paintPipelineDetail(run);
}

function paintPipelineSummary(run) {
  $("pipeline-summary").innerHTML =
    '<div class="eyebrow">' + esc(run.kind || "pipeline") + " · " + esc(run.status || "loading") + "</div>" +
    '<div class="title">' + esc(run.phase || "Loading flow") + "</div>" +
    '<div class="meta">owner ' + esc(run.ownerAgent || "—") + "<br />thread " +
    esc(shortId(run.threadId || run.id)) +
    (run.repoRefs?.length ? "<br />repos " + esc(run.repoRefs.join(", ")) : "") +
    "</div>";
  $("pipeline-detail").style.display = "none";
  $("pipeline-status").textContent = pipelineDetailLoadingId === run.id
    ? "Loading selected pipeline…"
    : pipelineDetailErrors.has(run.id)
      ? "Failed to load selected pipeline. Use refresh to retry."
      : "Select this run to load its dispatch flow.";
}

async function loadPipelineDetail(runId, force = false) {
  if (!runId || pipelineDetailLoadingId === runId) return;
  if (!force && pipelineDetailErrors.has(runId)) return;
  if (!force && pipelineDetails.has(runId)) return;
  pipelineDetailAbortController?.abort();
  const controller = new AbortController();
  pipelineDetailAbortController = controller;
  pipelineDetailErrors.delete(runId);
  pipelineDetailLoadingId = runId;
  const summary = pipelines.find((candidate) => candidate.id === runId);
  if (selectedPipelineId === runId && summary) paintPipelineSummary(summary);
  const response = await safeFetch(
    "/api/pipelines/" + encodeURIComponent(runId),
    { signal: controller.signal },
  );
  if (controller.signal.aborted) return;
  if (pipelineDetailAbortController === controller) pipelineDetailAbortController = null;
  if (pipelineDetailLoadingId === runId) pipelineDetailLoadingId = null;
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
  } else if (selectedPipelineId === runId) {
    pipelineDetailErrors.add(runId);
    $("pipeline-status").textContent = "Failed to load selected pipeline.";
  }
  if (selectedPipelineId === runId) renderPipelines();
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
    (transitions.length ? "<br />phase trail " + esc(transitions.map((item) => item.toPhase).join(" → ")) : "") +
    "</div>";
  const selectedAssignment = (run.assignments || []).find(
    (assignment) => assignment.id === PIPE.selectedNodeId,
  );
  const node = PIPE.selectedNodeId === "run:" + run.id
    ? pipelineNodeFromAssignment(run, null, { id: PIPE.selectedNodeId })
    : selectedAssignment
      ? pipelineNodeFromAssignment(run, selectedAssignment, {
        id: selectedAssignment.id,
      })
      : null;
  const detail = $("pipeline-detail");
  const rail = detail.closest(".pipeline-rail");
  if (!node) {
    rail.classList.remove("chat-open");
    detail.style.display = "none";
    detail.innerHTML = "";
    return;
  }
  detail.style.display = "";
  if (node.type === "run") {
    rail.classList.remove("chat-open");
    detail.innerHTML =
      '<div class="eyebrow">selected run</div><div class="objective">' + esc(run.kind) +
      " pipeline is " + esc(run.status) + " in " + esc(run.phase) + ".</div>" +
      '<div class="meta">created ' + ago(run.createdAt) + " ago<br />updated " + ago(run.updatedAt) +
      " ago<br />state version " + esc(run.stateVersion) + "</div>";
    return;
  }
  const assignment = node.assignment;
  const agent = assignment.targetAgent;
  const conversation = agentConversation(run, agent);
  rail.classList.add("chat-open");
  detail.innerHTML =
    '<button class="chat-close" type="button" data-close-agent-chat>close</button>' +
    '<div class="eyebrow">agent chat · ' + esc(agent) + "</div>" +
    '<div class="meta">' + conversation.length + " durable message" +
    (conversation.length === 1 ? "" : "s") + " across this run</div>" +
    '<div class="agent-chat">' +
    (conversation.length
      ? conversation.map(renderAgentMessage).join("")
      : '<div class="empty">No durable messages recorded for this agent.</div>') +
    "</div>";
}

function agentConversation(run, agent) {
  const entries = [];
  for (const assignment of run.assignments || []) {
    if (assignment.targetAgent === agent) {
      entries.push({
        direction: "in",
        from: assignment.sourceAgent,
        to: agent,
        message: assignment.objective,
        result: "assignment · " + assignment.status +
          (assignment.dispatch ? " · dispatch " + assignment.dispatch.status : ""),
        at: assignment.createdAt,
      });
      for (const outcome of assignment.outcomes || []) {
        const checks = (outcome.checks || []).length
          ? " · checks " + outcome.checks.map((check) => check.name + ":" + check.status).join(", ")
          : "";
        const blockers = (outcome.blockers || []).length
          ? " · blockers " + outcome.blockers.map((blocker) => blocker.kind).join(", ")
          : "";
        entries.push({
          direction: "out",
          from: agent,
          to: "pipeline",
          message: outcome.reason,
          result: outcome.action + " · " + outcome.status + checks + blockers,
          at: outcome.createdAt,
        });
      }
    }
    if (assignment.sourceAgent === agent && assignment.targetAgent !== agent) {
      entries.push({
        direction: "out",
        from: agent,
        to: assignment.targetAgent,
        message: assignment.objective,
        result: "handoff · " + assignment.status,
        at: assignment.createdAt,
      });
    }
  }
  return entries.sort((a, b) => a.at - b.at);
}

function renderAgentMessage(entry) {
  return '<div class="chat-entry ' + entry.direction + '">' +
    '<div class="who"><span>' + esc(entry.from) + " → " + esc(entry.to) +
    "</span><time>" + ago(entry.at) + " ago</time></div>" +
    '<div class="message">' + esc(entry.message) + "</div>" +
    '<div class="result">' + esc(entry.result) + "</div></div>";
}

$("pipeline-runs").addEventListener("click", (event) => {
  const row = event.target.closest("[data-pipeline-id]");
  if (!row) return;
  if (selectedPipelineId === row.dataset.pipelineId) return;
  pipelineDetailAbortController?.abort();
  pipelineDetailAbortController = null;
  pipelineDetailLoadingId = null;
  selectedPipelineId = row.dataset.pipelineId;
  PIPE.selectedNodeId = null;
  pipelineDetailErrors.delete(selectedPipelineId);
  if (currentView() === "pipelines") renderPipelines();
});
$("pipeline-detail").addEventListener("click", (event) => {
  if (!event.target.closest("[data-close-agent-chat]")) return;
  PIPE.selectedNodeId = null;
  const run = pipelineDetails.get(selectedPipelineId);
  if (run) paintPipelineDetail(run);
});
$("pipeline-filter").addEventListener("change", () => refreshPipelineControlPlane());
$("pipeline-kind").addEventListener("change", () => refreshPipelineControlPlane());
$("pipeline-refresh").addEventListener("click", () => {
  if (selectedPipelineId) {
    pipelineDetails.delete(selectedPipelineId);
    pipelineDetailErrors.delete(selectedPipelineId);
  }
  refreshPipelineControlPlane();
});
$("pipeline-fit").addEventListener("click", () => fitPipeline());
$("pipeline-reset").addEventListener("click", () => {
  PIPE.yaw = 0;
  PIPE.pitch = 0;
  fitPipeline();
});

function fitPipeline() {
  if (!PIPE.group || !PIPE.nodeElements.length) return;
  PIPE.group.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(PIPE.group);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  PIPE.target.copy(center);
  PIPE.yaw = PIPE.width < 600 ? -0.12 : -0.22;
  PIPE.pitch = PIPE.width < 600 ? 0.07 : 0.13;
  const halfFov = THREE.MathUtils.degToRad(PIPE.camera.fov * 0.5);
  const verticalFit = size.y * 0.5 / Math.tan(halfFov);
  const horizontalFit = size.x * 0.5 / (Math.tan(halfFov) * PIPE.camera.aspect);
  PIPE.desiredDistance = Math.max(8, verticalFit, horizontalFit) * 1.16;
  PIPE.distance = PIPE.desiredDistance;
  updatePipelineCamera();
  invalidatePipeline();
}

function updatePipelineCamera() {
  if (!PIPE.camera) return;
  const cosPitch = Math.cos(PIPE.pitch);
  PIPE.camera.position.set(
    PIPE.target.x + Math.sin(PIPE.yaw) * cosPitch * PIPE.distance,
    PIPE.target.y + Math.sin(PIPE.pitch) * PIPE.distance,
    PIPE.target.z + Math.cos(PIPE.yaw) * cosPitch * PIPE.distance,
  );
  PIPE.camera.lookAt(PIPE.target);
  PIPE.nodesNeedProject = true;
}

function projectPipelineNodes() {
  if (!PIPE.camera || !PIPE.nodeElements.length) return;
  PIPE.camera.updateMatrixWorld();
  const focalLength = PIPE.height /
    (2 * Math.tan(THREE.MathUtils.degToRad(PIPE.camera.fov * 0.5)));
  const projected = new THREE.Vector3();
  const view = new THREE.Vector3();
  for (const element of PIPE.nodeElements) {
    const position = PIPE.nodePositions.get(element.dataset.pipelineNodeId);
    if (!position) continue;
    projected.copy(position).project(PIPE.camera);
    view.copy(position).applyMatrix4(PIPE.camera.matrixWorldInverse);
    const visible = projected.z >= -1 && projected.z <= 1 && view.z < 0 &&
      projected.x >= -1.3 && projected.x <= 1.3 &&
      projected.y >= -1.3 && projected.y <= 1.3;
    if (!visible) {
      element.style.display = "none";
      continue;
    }
    element.style.display = "";
    const x = (projected.x * 0.5 + 0.5) * PIPE.width;
    const y = (-projected.y * 0.5 + 0.5) * PIPE.height;
    const baseWidth = element._pipelineBaseWidth ||
      (element._pipelineBaseWidth = element.offsetWidth || 190);
    const scale = Math.max(0.2, Math.min(1.6, (3 * focalLength / -view.z) / baseWidth));
    element.style.transform =
      "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) +
      "px,0) translate(-50%,-50%) scale(" + scale.toFixed(3) + ")";
    element.style.zIndex = String(Math.max(1, Math.round(10000 + view.z * 10)));
  }
  PIPE.nodesNeedProject = false;
}

function invalidatePipeline() {
  PIPE.needsRender = true;
  if (PIPE.frameRequest == null && currentView() === "pipelines") {
    PIPE.frameRequest = requestAnimationFrame(pipelineFrame);
  }
}

function resizePipeline() {
  ensurePipelineRenderer();
  const rect = $("pipeline-stage").getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  PIPE.width = rect.width;
  PIPE.height = rect.height;
  PIPE.renderer.setSize(rect.width, rect.height, false);
  PIPE.camera.aspect = rect.width / rect.height;
  PIPE.camera.updateProjectionMatrix();
  PIPE.nodesNeedProject = true;
  invalidatePipeline();
  const nextMode = rect.width < 600 ? "vertical" : "horizontal";
  if (PIPE.group && PIPE.layoutMode && PIPE.layoutMode !== nextMode) {
    const run = pipelineDetails.get(selectedPipelineId);
    if (run) void buildPipelineScene(run);
  }
}

PIPE.canvas.addEventListener("pointerdown", (event) => {
  PIPE.drag = {
    x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
    yaw: PIPE.yaw, pitch: PIPE.pitch, target: PIPE.target.clone(),
    pan: event.shiftKey || event.button === 2,
  };
  PIPE.canvas.setPointerCapture(event.pointerId);
  PIPE.canvas.classList.add("dragging");
});
PIPE.canvas.addEventListener("pointermove", (event) => {
  if (PIPE.drag) {
    const dx = event.clientX - PIPE.drag.x;
    const dy = event.clientY - PIPE.drag.y;
    if (PIPE.drag.pan) {
      const scale = PIPE.distance / Math.max(PIPE.height, 1) * 1.4;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(PIPE.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(PIPE.camera.quaternion);
      PIPE.target.copy(PIPE.drag.target).addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    } else {
      PIPE.yaw = PIPE.drag.yaw - dx * 0.005;
      PIPE.pitch = Math.max(-1.15, Math.min(1.15, PIPE.drag.pitch + dy * 0.004));
    }
    updatePipelineCamera();
    invalidatePipeline();
    return;
  }
  PIPE.canvas.style.cursor = "grab";
});
PIPE.canvas.addEventListener("pointerup", (event) => {
  if (!PIPE.drag) return;
  const moved = Math.hypot(event.clientX - PIPE.drag.startX, event.clientY - PIPE.drag.startY);
  PIPE.drag = null;
  PIPE.canvas.classList.remove("dragging");
  if (moved < 5) {
    PIPE.selectedNodeId = null;
    for (const element of PIPE.nodeElements) element.classList.remove("selected");
    const run = pipelineDetails.get(selectedPipelineId);
    if (run) paintPipelineDetail(run);
  }
});
PIPE.canvas.addEventListener("pointercancel", () => {
  PIPE.drag = null;
  PIPE.canvas.classList.remove("dragging");
});
PIPE.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
PIPE.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  PIPE.desiredDistance = Math.max(4.5, Math.min(60, PIPE.desiredDistance * Math.exp(event.deltaY * 0.001)));
  invalidatePipeline();
}, { passive: false });

PIPE.nodeLayer.addEventListener("click", (event) => {
  const card = event.target.closest("[data-pipeline-node-id]");
  if (!card) return;
  PIPE.selectedNodeId = card.dataset.pipelineNodeId;
  for (const element of PIPE.nodeElements) {
    element.classList.toggle("selected", element === card);
  }
  const run = pipelineDetails.get(selectedPipelineId);
  if (run) paintPipelineDetail(run);
});

function pipelineFrame(now) {
  PIPE.frameRequest = null;
  if (!PIPE.renderer || document.hidden || currentView() !== "pipelines") return;
  if (now - PIPE.lastFrameAt < 50) {
    invalidatePipeline();
    return;
  }
  const cameraMoving = Math.abs(PIPE.desiredDistance - PIPE.distance) > 0.002;
  if (!PIPE.needsRender && !cameraMoving && PIPE.packets.length === 0) return;
  PIPE.lastFrameAt = now;
  if (cameraMoving) {
    PIPE.distance += (PIPE.desiredDistance - PIPE.distance) * 0.14;
    updatePipelineCamera();
  }
  for (const packet of PIPE.packets) {
    const progress = (now * 0.001 * packet.speed + packet.offset) % 1;
    packet.mesh.position.copy(packet.curve.getPoint(progress));
    packet.mesh.scale.setScalar(0.8 + Math.sin(now * 0.008 + packet.offset * 10) * 0.18);
  }
  if (PIPE.nodesNeedProject) projectPipelineNodes();
  PIPE.renderer.render(PIPE.scene, PIPE.camera);
  PIPE.needsRender = false;
  if (cameraMoving || PIPE.packets.length > 0) invalidatePipeline();
}
if (window.ResizeObserver) new ResizeObserver(resizePipeline).observe($("pipeline-stage"));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) invalidatePipeline();
});
