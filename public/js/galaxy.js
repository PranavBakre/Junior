/* =================== memory galaxy =================== */
/* The server owns semantic layout (PCA + spread + KNN); Three.js owns the
   interactive view. Claims are GPU point sprites, links are dynamic line
   buffers, and the existing DOM rail remains the accessible detail surface. */
const KINDS = ["lesson", "fact", "situation-claim"];
const PALETTE = [[52, 211, 153], [59, 130, 246], [167, 110, 255], [150, 150, 150]];
const MAX_ROWS = 200;
const kindIdx = (kind) => { const i = KINDS.indexOf(kind); return i < 0 ? 3 : i; };
const kindColor = (kind) => { const c = PALETTE[kindIdx(kind)]; return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; };

const GAL = {
  canvas: $("memory-canvas"),
  renderer: null,
  scene: null,
  camera3: null,
  pointCloud: null,
  linkLines: null,
  focusLines: null,
  hoverMarker: null,
  selectionMarker: null,
  pointSize: null,
  pointAlpha: null,
  pointStyleState: null,
  linkState: null,
  tip: $("cloud-tip"),
  status: $("cloud-status"),
  points: [],
  byId: new Map(),
  neighbors: new Map(),   // id -> [{id, sim}] strongest first
  edgeA: null, edgeB: null, edgeSim: null,  // KNN edges as index pairs
  facets: { tags: [], kinds: [], repos: [] },
  w: 0, h: 0, dpr: 1,
  sx: null, sy: null, sr: null, sz: null, svis: null, // picking + tooltip screen cache
  cam: { yaw: 0.6, pitch: 0.32, dist: 2.1, tx: 0, ty: 0, tz: 0 },
  vYaw: 0, vPitch: 0,
  drag: null,
  fly: null,
  lastInput: 0,
  spinOn: true,
  linksOn: true,
  hoverId: null,
  selId: null,
  filter: { text: "", tags: new Set(), kinds: new Set(), repo: "" },
  matches: null,     // Set of matching ids, or null when nothing is filtered
  scores: null,      // id -> semantic recall score, or null
  tagQuery: "",
  dirty: true,
};

/* ---------- load ---------- */
function setGalStatus(text) {
  GAL.status.textContent = text || "";
  GAL.status.style.display = text ? "" : "none";
}

async function loadGalaxy(force) {
  setGalStatus(force ? "rebuilding the projection…" : "projecting the claim space…");
  const res = await safeFetch("/api/memory/projection" + (force ? "?refresh=1" : ""));
  galaxyLoaded = true;
  if (!res.ok) {
    setGalStatus("Failed to load the projection.");
    $("claim-list").innerHTML = '<div class="empty">Failed to load claims.</div>';
    return;
  }
  ingestGalaxy(res.data);
}

function ingestGalaxy(data) {
  const points = (data && data.points) || [];
  GAL.points = points;
  GAL.byId = new Map(points.map((p) => [p.id, p]));
  GAL.idxById = new Map(points.map((p, i) => [p.id, i]));
  GAL.facets = (data && data.facets) || { tags: [], kinds: [], repos: [] };
  GAL.selId = null;
  GAL.hoverId = null;

  // Precompute a lowercase haystack per claim so the text filter is a single
  // substring test per point instead of rebuilding strings on every keystroke.
  for (const p of points) {
    p.hay = (p.text + " " + (p.tags || []).join(" ") + " " + (p.repo || "")).toLowerCase();
  }

  const edges = (data && data.edges) || [];
  const index = new Map(points.map((p, i) => [p.id, i]));
  GAL.edgeA = new Int32Array(edges.length);
  GAL.edgeB = new Int32Array(edges.length);
  GAL.edgeSim = new Float32Array(edges.length);
  GAL.neighbors = new Map();
  let m = 0;
  for (const e of edges) {
    const ai = index.get(e.a);
    const bi = index.get(e.b);
    if (ai === undefined || bi === undefined) continue;
    GAL.edgeA[m] = ai; GAL.edgeB[m] = bi; GAL.edgeSim[m] = e.sim; m += 1;
    pushNeighbor(e.a, e.b, e.sim);
    pushNeighbor(e.b, e.a, e.sim);
  }
  GAL.edgeCount = m;
  for (const list of GAL.neighbors.values()) list.sort((a, b) => b.sim - a.sim);

  const n = points.length;
  GAL.sx = new Float32Array(n);
  GAL.sy = new Float32Array(n);
  GAL.sr = new Float32Array(n);
  GAL.sz = new Float32Array(n);
  GAL.svis = new Uint8Array(n);
  buildGalaxyScene();

  setGalStatus(n ? null : "No claims with embeddings yet.");
  resetView(false);
  renderKindChips();
  renderRepoChips();
  renderTagPicker();
  applyFilter();
}

function pushNeighbor(from, to, sim) {
  const list = GAL.neighbors.get(from);
  if (list) list.push({ id: to, sim });
  else GAL.neighbors.set(from, [{ id: to, sim }]);
}

/* ---------- camera ---------- */
const clampPitch = (p) => Math.max(-1.45, Math.min(1.45, p));

function resetView(animate) {
  const goal = { tx: 0, ty: 0, tz: 0, dist: 2.1 };
  if (animate) flyTo(goal);
  else { Object.assign(GAL.cam, goal, { yaw: 0.6, pitch: 0.32 }); GAL.dirty = true; }
}

function flyTo(goal, ms) {
  const cam = GAL.cam;
  GAL.fly = {
    start: performance.now(), dur: ms || 620,
    from: { tx: cam.tx, ty: cam.ty, tz: cam.tz, dist: cam.dist },
    to: { tx: goal.tx, ty: goal.ty, tz: goal.tz, dist: goal.dist == null ? cam.dist : goal.dist },
  };
}

/** Fit the camera around whatever the filter currently matches. */
function frameMatches() {
  const list = matchedPoints();
  if (!list.length) return;
  let cx = 0, cy = 0, cz = 0;
  for (const p of list) { cx += p.x; cy += p.y; cz += p.z; }
  cx /= list.length; cy /= list.length; cz /= list.length;
  let radius = 0;
  for (const p of list) {
    const d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
    if (d > radius) radius = d;
  }
  flyTo({ tx: cx, ty: cy, tz: cz, dist: Math.max(0.45, radius * 2.1 + 0.35) });
}

function stepCamera(now) {
  const cam = GAL.cam;
  let moved = false;

  if (GAL.fly) {
    const f = GAL.fly;
    const t = Math.min(1, (now - f.start) / f.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    cam.tx = f.from.tx + (f.to.tx - f.from.tx) * e;
    cam.ty = f.from.ty + (f.to.ty - f.from.ty) * e;
    cam.tz = f.from.tz + (f.to.tz - f.from.tz) * e;
    cam.dist = f.from.dist + (f.to.dist - f.from.dist) * e;
    if (t >= 1) GAL.fly = null;
    moved = true;
  } else if (!GAL.drag && (Math.abs(GAL.vYaw) > 2e-5 || Math.abs(GAL.vPitch) > 2e-5)) {
    // Release inertia — the galaxy keeps drifting after a flick, then settles.
    cam.yaw += GAL.vYaw;
    cam.pitch = clampPitch(cam.pitch + GAL.vPitch);
    GAL.vYaw *= 0.93;
    GAL.vPitch *= 0.93;
    moved = true;
  }

  if (GAL.spinOn && !GAL.drag && !GAL.fly && now - GAL.lastInput > 2500) {
    cam.yaw += 0.0011;
    moved = true;
  }
  if (moved) GAL.dirty = true;
}

function galaxyFrame(now) {
  requestAnimationFrame(galaxyFrame);
  if (!GAL.points.length || currentView() !== "memory") return;
  stepCamera(now);
  if (GAL.dirty) { paintGalaxy(); GAL.dirty = false; }
}

/* ---------- render ---------- */
function ensureGalaxyRenderer() {
  if (GAL.renderer) return;
  GAL.renderer = new THREE.WebGLRenderer({
    canvas: GAL.canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  GAL.renderer.outputColorSpace = THREE.SRGBColorSpace;
  GAL.renderer.setClearColor(0x030408, 0);
  GAL.scene = new THREE.Scene();
  GAL.scene.fog = new THREE.FogExp2(0x030408, 0.075);
  GAL.camera3 = new THREE.PerspectiveCamera(58, 1, 0.02, 80);

  const markerGeometry = new THREE.RingGeometry(0.017, 0.022, 40);
  GAL.hoverMarker = new THREE.Mesh(
    markerGeometry,
    new THREE.MeshBasicMaterial({
      color: 0xb7d0ff,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  GAL.selectionMarker = new THREE.Mesh(
    markerGeometry.clone(),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  GAL.selectionMarker.scale.setScalar(1.3);
  GAL.hoverMarker.visible = false;
  GAL.selectionMarker.visible = false;
  GAL.scene.add(GAL.hoverMarker, GAL.selectionMarker);
}

function disposeGalaxyObject(object) {
  if (!object) return;
  GAL.scene.remove(object);
  object.geometry?.dispose();
  if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
  else object.material?.dispose();
}

function buildGalaxyScene() {
  ensureGalaxyRenderer();
  disposeGalaxyObject(GAL.pointCloud);
  disposeGalaxyObject(GAL.linkLines);
  disposeGalaxyObject(GAL.focusLines);

  const pointCount = GAL.points.length;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Float32Array(pointCount * 3);
  const sizes = new Float32Array(pointCount);
  const alphas = new Float32Array(pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    const point = GAL.points[index];
    positions[index * 3] = point.x;
    positions[index * 3 + 1] = point.y;
    positions[index * 3 + 2] = point.z;
    const color = PALETTE[kindIdx(point.kind)];
    colors[index * 3] = color[0] / 255;
    colors[index * 3 + 1] = color[1] / 255;
    colors[index * 3 + 2] = color[2] / 255;
    sizes[index] = 8.5 + Math.min(2, Math.max(0, point.weight || 0)) * 3.2;
    alphas[index] = 0.66;
  }

  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  pointGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  GAL.pointSize = new THREE.BufferAttribute(sizes, 1);
  GAL.pointAlpha = new THREE.BufferAttribute(alphas, 1);
  GAL.pointSize.setUsage(THREE.DynamicDrawUsage);
  GAL.pointAlpha.setUsage(THREE.DynamicDrawUsage);
  pointGeometry.setAttribute("pointSize", GAL.pointSize);
  pointGeometry.setAttribute("pointAlpha", GAL.pointAlpha);

  const pointMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      pixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.75) },
    },
    vertexShader: `
      attribute float pointSize;
      attribute float pointAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float pixelRatio;
      void main() {
        vColor = color;
        vAlpha = pointAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float depthScale = clamp(1.8 / max(0.15, -mvPosition.z), 0.42, 2.8);
        gl_PointSize = pointSize * pixelRatio * depthScale;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float radius = length(gl_PointCoord - vec2(0.5));
        if (radius > 0.5) discard;
        float glow = 1.0 - smoothstep(0.08, 0.5, radius);
        float core = 1.0 - smoothstep(0.0, 0.13, radius);
        gl_FragColor = vec4(vColor * (0.72 + core * 0.75), vAlpha * max(glow, core));
      }
    `,
  });
  GAL.pointCloud = new THREE.Points(pointGeometry, pointMaterial);
  GAL.pointCloud.frustumCulled = false;
  GAL.scene.add(GAL.pointCloud);
  GAL.pointStyleState = null;
  GAL.linkState = null;

  const linkGeometry = new THREE.BufferGeometry();
  const linkPositions = new THREE.BufferAttribute(
    new Float32Array(Math.max(6, (GAL.edgeCount || 0) * 6)),
    3,
  );
  linkPositions.setUsage(THREE.DynamicDrawUsage);
  linkGeometry.setAttribute("position", linkPositions);
  GAL.linkLines = new THREE.LineSegments(
    linkGeometry,
    new THREE.LineBasicMaterial({
      color: 0x6595df,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  GAL.scene.add(GAL.linkLines);

  const focusGeometry = new THREE.BufferGeometry();
  const focusPositions = new THREE.BufferAttribute(
    new Float32Array(Math.max(6, (GAL.edgeCount || 0) * 6)),
    3,
  );
  focusPositions.setUsage(THREE.DynamicDrawUsage);
  focusGeometry.setAttribute("position", focusPositions);
  GAL.focusLines = new THREE.LineSegments(
    focusGeometry,
    new THREE.LineBasicMaterial({
      color: 0xb1d0ff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  GAL.scene.add(GAL.focusLines);
  resizeGalaxy();
}

function resizeGalaxy() {
  const wrap = $("galaxy-wrap");
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  GAL.w = Math.max(1, Math.round(rect.width));
  GAL.h = Math.max(1, Math.round(rect.height));
  ensureGalaxyRenderer();
  GAL.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  GAL.renderer.setPixelRatio(GAL.dpr);
  GAL.renderer.setSize(GAL.w, GAL.h, false);
  GAL.camera3.aspect = GAL.w / GAL.h;
  GAL.camera3.updateProjectionMatrix();
  if (GAL.pointCloud) GAL.pointCloud.material.uniforms.pixelRatio.value = GAL.dpr;
  GAL.dirty = true;
}

function updateGalaxyCamera() {
  const cam = GAL.cam;
  const cosPitch = Math.cos(cam.pitch);
  GAL.camera3.position.set(
    cam.tx + Math.sin(cam.yaw) * cosPitch * cam.dist,
    cam.ty + Math.sin(cam.pitch) * cam.dist,
    cam.tz + Math.cos(cam.yaw) * cosPitch * cam.dist,
  );
  GAL.camera3.lookAt(cam.tx, cam.ty, cam.tz);
  GAL.camera3.updateMatrixWorld();
}

function syncGalaxyLinks(focusId) {
  if (!GAL.linkLines || !GAL.focusLines) return;
  const matches = GAL.matches;
  if (
    GAL.linkState &&
    GAL.linkState.matches === matches &&
    GAL.linkState.linksOn === GAL.linksOn &&
    GAL.linkState.focusId === focusId
  ) return;
  GAL.linkState = { matches, linksOn: GAL.linksOn, focusId };
  const linkArray = GAL.linkLines.geometry.attributes.position.array;
  const focusArray = GAL.focusLines.geometry.attributes.position.array;
  let linkOffset = 0;
  let focusOffset = 0;
  for (let edgeIndex = 0; edgeIndex < (GAL.edgeCount || 0); edgeIndex += 1) {
    const a = GAL.edgeA[edgeIndex];
    const b = GAL.edgeB[edgeIndex];
    const pointA = GAL.points[a];
    const pointB = GAL.points[b];
    const visibleMatch = !matches || (matches.has(pointA.id) && matches.has(pointB.id));
    if (GAL.linksOn && visibleMatch) {
      linkArray[linkOffset++] = pointA.x;
      linkArray[linkOffset++] = pointA.y;
      linkArray[linkOffset++] = pointA.z;
      linkArray[linkOffset++] = pointB.x;
      linkArray[linkOffset++] = pointB.y;
      linkArray[linkOffset++] = pointB.z;
    }
    if (focusId != null && (pointA.id === focusId || pointB.id === focusId)) {
      focusArray[focusOffset++] = pointA.x;
      focusArray[focusOffset++] = pointA.y;
      focusArray[focusOffset++] = pointA.z;
      focusArray[focusOffset++] = pointB.x;
      focusArray[focusOffset++] = pointB.y;
      focusArray[focusOffset++] = pointB.z;
    }
  }
  GAL.linkLines.geometry.setDrawRange(0, linkOffset / 3);
  GAL.focusLines.geometry.setDrawRange(0, focusOffset / 3);
  GAL.linkLines.geometry.attributes.position.needsUpdate = true;
  GAL.focusLines.geometry.attributes.position.needsUpdate = true;
}

function syncGalaxyMarker(marker, id) {
  const point = id != null ? GAL.byId.get(id) : null;
  marker.visible = !!point;
  if (!point) return;
  marker.position.set(point.x, point.y, point.z);
  marker.lookAt(GAL.camera3.position);
}

function paintGalaxy() {
  if (!GAL.renderer || !GAL.pointCloud) return;
  const { w, h, points, cam } = GAL;
  const n = points.length;
  if (!n || !w) return;
  updateGalaxyCamera();
  const matches = GAL.matches;
  const styleChanged = !GAL.pointStyleState ||
    GAL.pointStyleState.matches !== matches ||
    GAL.pointStyleState.scores !== GAL.scores ||
    GAL.pointStyleState.hoverId !== GAL.hoverId ||
    GAL.pointStyleState.selId !== GAL.selId;
  const projected = new THREE.Vector3();
  const worldPoint = new THREE.Vector3();
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    worldPoint.set(p.x, p.y, p.z);
    projected.copy(worldPoint).project(GAL.camera3);
    const depth = GAL.camera3.position.distanceTo(worldPoint);
    GAL.sx[i] = (projected.x * 0.5 + 0.5) * w;
    GAL.sy[i] = (-projected.y * 0.5 + 0.5) * h;
    GAL.sz[i] = depth;
    const baseSize = 8.5 + Math.min(2, Math.max(0, p.weight || 0)) * 3.2;
    const depthScale = Math.max(0.42, Math.min(2.8, 1.8 / Math.max(0.15, depth)));
    let size = baseSize;
    let alpha = 0.66;
    if (matches && !matches.has(p.id)) { alpha = 0.055; size *= 0.72; }
    else if (matches) {
      alpha = 0.94;
      size *= 1.28;
      if (GAL.scores) {
        const s = GAL.scores.get(p.id) || 0;
        size *= 1 + Math.min(1, s / (GAL.topScore || 1)) * 0.5;
      }
    }
    if (p.id === GAL.selId) size *= 1.65;
    else if (p.id === GAL.hoverId) size *= 1.35;
    if (styleChanged) {
      GAL.pointSize.array[i] = size;
      GAL.pointAlpha.array[i] = alpha;
    }
    GAL.sr[i] = Math.max(2, size * depthScale * 0.5);
    GAL.svis[i] = projected.z > -1 && projected.z < 1 &&
      projected.x > -1.1 && projected.x < 1.1 &&
      projected.y > -1.1 && projected.y < 1.1 ? 1 : 0;
  }
  if (styleChanged) {
    GAL.pointSize.needsUpdate = true;
    GAL.pointAlpha.needsUpdate = true;
    GAL.pointStyleState = {
      matches,
      scores: GAL.scores,
      hoverId: GAL.hoverId,
      selId: GAL.selId,
    };
  }
  const focusId = GAL.hoverId != null ? GAL.hoverId : GAL.selId;
  syncGalaxyLinks(focusId);
  syncGalaxyMarker(GAL.hoverMarker, GAL.hoverId);
  syncGalaxyMarker(GAL.selectionMarker, GAL.selId);
  GAL.renderer.render(GAL.scene, GAL.camera3);
  updateGalStats();
}

function updateGalStats() {
  const shown = GAL.matches ? GAL.matches.size : GAL.points.length;
  const text = shown + " / " + GAL.points.length + " stars · " + (GAL.edgeCount || 0) + " links";
  if (text === GAL.statsText) return; // paints run at 60fps; the DOM write must not
  GAL.statsText = text;
  $("gal-stats").textContent = text;
}

/* ---------- picking / hover ---------- */
function pickAt(evt) {
  const rect = GAL.canvas.getBoundingClientRect();
  const mx = evt.clientX - rect.left;
  const my = evt.clientY - rect.top;
  let bestI = -1;
  let bestScore = Infinity;
  for (let i = 0; i < GAL.points.length; i += 1) {
    if (!GAL.svis[i]) continue;
    const reach = Math.max(10, GAL.sr[i] + 6);
    const d = Math.hypot(GAL.sx[i] - mx, GAL.sy[i] - my);
    if (d > reach) continue;
    // Closest to the pointer wins; near-ties break toward the star nearest the camera.
    const score = d / reach + GAL.sz[i] * 0.02;
    if (score < bestScore) { bestScore = score; bestI = i; }
  }
  return bestI < 0 ? null : GAL.points[bestI];
}

function hoverAt(evt) {
  const hit = pickAt(evt);
  const id = hit ? hit.id : null;
  if (id !== GAL.hoverId) { GAL.hoverId = id; GAL.dirty = true; }
  if (!hit) { GAL.tip.style.display = "none"; return; }
  const tags = (hit.tags || []).length
    ? '<div style="color:var(--fg-faint);margin-top:5px">' + hit.tags.map(esc).join(" · ") + "</div>"
    : "";
  GAL.tip.innerHTML =
    '<div style="color:' + kindColor(hit.kind) + ';font-size:9.5px;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px">' +
    esc(hit.kind) + (hit.repo ? " · " + esc(hit.repo) : "") + "</div>" +
    '<div style="color:var(--fg)">' + esc(clip(hit.text, 240)) + "</div>" + tags;
  GAL.tip.style.display = "block";
  const i = GAL.idxById.get(hit.id);
  let tx = GAL.sx[i] + 14;
  let ty = GAL.sy[i] + 14;
  if (tx + GAL.tip.offsetWidth > GAL.w) tx = GAL.sx[i] - GAL.tip.offsetWidth - 14;
  if (ty + GAL.tip.offsetHeight > GAL.h) ty = GAL.h - GAL.tip.offsetHeight - 8;
  GAL.tip.style.left = Math.max(0, tx) + "px";
  GAL.tip.style.top = Math.max(0, ty) + "px";
}

const clip = (s, max) => (s && s.length > max ? s.slice(0, max - 1) + "…" : s || "");

function selectClaim(id, fly) {
  GAL.selId = id;
  GAL.dirty = true;
  const p = id && GAL.byId.get(id);
  if (p && fly) flyTo({ tx: p.x, ty: p.y, tz: p.z, dist: Math.min(GAL.cam.dist, 1.15) });
  renderDetail();
  markSelectedRow();
}

/* ---------- filters ---------- */
function pointMatches(p) {
  const f = GAL.filter;
  if (f.kinds.size && !f.kinds.has(p.kind)) return false;
  if (f.repo && p.repo !== f.repo) return false;
  for (const tag of f.tags) if (!p.tags.includes(tag)) return false;
  if (GAL.scores) return GAL.scores.has(p.id);
  if (f.text && !p.hay.includes(f.text)) return false;
  return true;
}

function filterActive() {
  const f = GAL.filter;
  return !!(f.text || f.repo || f.tags.size || f.kinds.size || GAL.scores);
}

function matchedPoints() {
  return GAL.matches ? GAL.points.filter((p) => GAL.matches.has(p.id)) : GAL.points;
}

function applyFilter(frame) {
  GAL.matches = filterActive()
    ? new Set(GAL.points.filter(pointMatches).map((p) => p.id))
    : null;
  GAL.dirty = true;
  renderRail();
  renderTagPicker();
  if (frame) frameMatches();
}

/** Semantic recall — the server embeds the query, exactly like agent recall. */
async function semanticSearch() {
  const q = $("mem-q").value.trim();
  if (!q) { GAL.scores = null; GAL.filter.text = ""; applyFilter(); return; }
  setGalStatus("embedding the query…");
  const params = new URLSearchParams({ query: q, limit: "150" });
  if (GAL.filter.tags.size) params.set("tags", [...GAL.filter.tags].join(","));
  if (GAL.filter.kinds.size) params.set("kinds", [...GAL.filter.kinds].join(","));
  if (GAL.filter.repo) params.set("repo", GAL.filter.repo);
  const res = await safeFetch("/api/memory/recall?" + params.toString());
  setGalStatus(null);
  if (!res.ok) { setGalStatus("Recall failed."); return; }
  const results = res.data.results || [];
  GAL.scores = new Map(results.map((r) => [r.id, r.score]));
  GAL.topScore = results.length ? Math.max(...results.map((r) => r.score || 0)) : 1;
  applyFilter(true);
}

/* ---------- rail ---------- */
function renderRail() {
  const list = matchedPoints().slice();
  if (GAL.scores) list.sort((a, b) => (GAL.scores.get(b.id) || 0) - (GAL.scores.get(a.id) || 0));
  else list.sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));

  $("mem-rail-title").textContent = GAL.scores ? "recall ranking" : filterActive() ? "matches" : "recently used";
  $("mem-rail-count").textContent = list.length > MAX_ROWS
    ? "showing " + MAX_ROWS + " of " + list.length
    : list.length + (GAL.points.length && !filterActive() ? " claims" : " matched");

  if (!list.length) {
    $("claim-list").innerHTML = '<div class="empty">' +
      (GAL.points.length ? "Nothing matches these filters." : "No claims with embeddings yet.") + "</div>";
    return;
  }
  $("claim-list").innerHTML = list.slice(0, MAX_ROWS).map((p) => {
    const score = GAL.scores ? '<span class="score">' + (GAL.scores.get(p.id) || 0).toFixed(3) + "</span>" : "";
    const tags = (p.tags || []).length
      ? '<div class="tags">' + p.tags.map((t) => '<span data-tag="' + esc(t) + '">' + esc(t) + "</span>").join(" · ") + "</div>"
      : "";
    return '<div class="claim-row' + (p.id === GAL.selId ? " on" : "") + '" data-claim="' + esc(p.id) + '">' +
      '<div class="k ' + esc(p.kind) + '">' + esc(p.kind) + (p.repo ? " · " + esc(p.repo) : "") + score + "</div>" +
      '<div style="color:rgba(255,255,255,0.85)">' + esc(clip(p.text, 260)) + "</div>" + tags + "</div>";
  }).join("");
  markSelectedRow();
}

function markSelectedRow() {
  document.querySelectorAll("#claim-list .claim-row").forEach((row) => {
    row.classList.toggle("on", row.dataset.claim === GAL.selId);
  });
}

function renderDetail() {
  const p = GAL.selId && GAL.byId.get(GAL.selId);
  if (!p) { $("mem-detail").innerHTML = ""; return; }
  const near = (GAL.neighbors.get(p.id) || []).slice(0, 5).map((nb) => {
    const t = GAL.byId.get(nb.id);
    return t
      ? '<div class="nrow" data-claim="' + esc(t.id) + '"><span class="sim">' + nb.sim.toFixed(2) +
        '</span><span class="t" style="color:' + kindColor(t.kind) + '">▪</span>' +
        '<span class="t">' + esc(clip(t.text, 90)) + "</span></div>"
      : "";
  }).join("");
  $("mem-detail").innerHTML =
    '<div class="claim-detail">' +
    '<div style="font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:' + kindColor(p.kind) + '">' +
    esc(p.kind) + (p.repo ? " · " + esc(p.repo) : "") + "</div>" +
    '<div class="body">' + esc(p.text) + "</div>" +
    ((p.tags || []).length
      ? '<div class="tags" style="font-family:var(--font-mono);font-size:11px;color:var(--fg-faint);margin-bottom:6px">' +
        p.tags.map((t) => '<span data-tag="' + esc(t) + '" style="cursor:pointer">' + esc(t) + "</span>").join(" · ") + "</div>"
      : "") +
    '<div class="meta">weight ' + (p.weight || 0).toFixed(2) +
    " · created " + ago(p.createdAt) + " ago" +
    " · used " + (p.lastUsedAt ? ago(p.lastUsedAt) + " ago" : "never") + "</div>" +
    (near ? '<div class="near"><div class="meta" style="margin-bottom:4px">nearest in the full space</div>' + near + "</div>" : "") +
    "</div>";
}

/* ---------- filter chips ---------- */
function renderKindChips() {
  $("mem-kinds").innerHTML = (GAL.facets.kinds || []).map((k) =>
    '<span class="chip tag' + (GAL.filter.kinds.has(k.value) ? " on" : "") + '" data-kind="' + esc(k.value) + '">' +
    '<span style="color:' + kindColor(k.value) + '">▪</span> ' + esc(k.value) + '<span class="n">' + k.count + "</span></span>"
  ).join("") || '<span class="faint" style="font-size:11px">—</span>';
}

function renderRepoChips() {
  const repos = (GAL.facets.repos || []).slice(0, 8);
  $("mem-repos").innerHTML = repos.map((r) =>
    '<span class="chip tag' + (GAL.filter.repo === r.value ? " on" : "") + '" data-repo="' + esc(r.value) + '">' +
    esc(r.value) + '<span class="n">' + r.count + "</span></span>"
  ).join("") || '<span class="faint" style="font-size:11px">none tagged</span>';
}

function renderTagPicker() {
  const q = GAL.tagQuery;
  const selected = [...GAL.filter.tags].map((t) =>
    '<span class="chip tag on" data-tag-off="' + esc(t) + '">' + esc(t) + '<span class="x">✕</span></span>'
  ).join("");
  // Counts are recomputed against the CURRENT matches, so tag chips narrow as you
  // drill in and dead-end combinations are visibly zero-count (and dropped).
  const pool = matchedPoints();
  const counts = new Map();
  for (const p of pool) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  const list = (GAL.facets.tags || [])
    .filter((t) => !GAL.filter.tags.has(t.value) && (!q || t.value.toLowerCase().includes(q)) && counts.has(t.value))
    .map((t) => ({ value: t.value, count: counts.get(t.value) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, q ? 40 : 16);
  $("mem-tags").innerHTML = selected + list.map((t) =>
    '<span class="chip tag" data-tag="' + esc(t.value) + '">' + esc(t.value) + '<span class="n">' + t.count + "</span></span>"
  ).join("");
}

/* ---------- events ---------- */
GAL.canvas.addEventListener("pointerdown", (e) => {
  GAL.canvas.setPointerCapture(e.pointerId);
  GAL.canvas.classList.add("dragging");
  GAL.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1, moved: 0 };
  GAL.vYaw = 0; GAL.vPitch = 0; GAL.fly = null;
  GAL.lastInput = performance.now();
  GAL.tip.style.display = "none";
});

GAL.canvas.addEventListener("pointermove", (e) => {
  if (!GAL.drag) { hoverAt(e); return; }
  const dx = e.clientX - GAL.drag.x;
  const dy = e.clientY - GAL.drag.y;
  GAL.drag.x = e.clientX; GAL.drag.y = e.clientY;
  GAL.drag.moved += Math.abs(dx) + Math.abs(dy);
  if (GAL.drag.pan) panCamera(dx, dy);
  else {
    GAL.vYaw = -dx * 0.005;
    GAL.vPitch = -dy * 0.005;
    GAL.cam.yaw += GAL.vYaw;
    GAL.cam.pitch = clampPitch(GAL.cam.pitch + GAL.vPitch);
  }
  GAL.lastInput = performance.now();
  GAL.dirty = true;
});

GAL.canvas.addEventListener("pointerup", (e) => {
  const drag = GAL.drag;
  GAL.drag = null;
  GAL.canvas.classList.remove("dragging");
  GAL.lastInput = performance.now();
  if (drag && drag.moved > 6) return; // it was a rotate/pan, not a click
  const hit = pickAt(e);
  selectClaim(hit ? hit.id : null, !!hit);
});

GAL.canvas.addEventListener("pointerleave", () => {
  GAL.tip.style.display = "none";
  if (GAL.hoverId != null) { GAL.hoverId = null; GAL.dirty = true; }
});

GAL.canvas.addEventListener("dblclick", () => { resetView(true); GAL.lastInput = performance.now(); });

// Non-passive so preventDefault sticks: without it the wheel scrolls the whole
// dashboard behind the galaxy instead of zooming it.
GAL.canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  GAL.cam.dist = Math.max(0.18, Math.min(14, GAL.cam.dist * Math.exp(delta * 0.0013)));
  GAL.fly = null;
  GAL.lastInput = performance.now();
  GAL.dirty = true;
}, { passive: false });

/** Pan by moving the orbit target along the camera's own right/up axes. */
function panCamera(dx, dy) {
  const cam = GAL.cam;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const scale = cam.dist / (Math.min(GAL.w, GAL.h) * 0.85);
  const rightX = cy, rightY = 0, rightZ = -sy;
  const upX = -sy * sp, upY = cp, upZ = -cy * sp;
  cam.tx -= (rightX * dx - upX * dy) * scale;
  cam.ty -= (rightY * dx - upY * dy) * scale;
  cam.tz -= (rightZ * dx - upZ * dy) * scale;
}

$("cloud-refresh").addEventListener("click", () => loadGalaxy(true));
$("gal-reset").addEventListener("click", () => { resetView(true); GAL.lastInput = performance.now(); });
$("gal-frame").addEventListener("click", () => { frameMatches(); GAL.lastInput = performance.now(); });
$("gal-links").addEventListener("click", (e) => {
  GAL.linksOn = !GAL.linksOn;
  e.currentTarget.classList.toggle("on", GAL.linksOn);
  GAL.dirty = true;
});
$("gal-spin").addEventListener("click", (e) => {
  GAL.spinOn = !GAL.spinOn;
  e.currentTarget.classList.toggle("on", GAL.spinOn);
});

$("mem-q").addEventListener("input", (e) => {
  // Typing goes back to instant substring filtering; ⏎ escalates to embeddings.
  GAL.scores = null;
  GAL.filter.text = e.target.value.trim().toLowerCase();
  applyFilter();
});
$("mem-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); semanticSearch(); }
});
$("mem-clear").addEventListener("click", () => {
  $("mem-q").value = "";
  $("mem-tag-q").value = "";
  GAL.filter = { text: "", tags: new Set(), kinds: new Set(), repo: "" };
  GAL.scores = null;
  GAL.tagQuery = "";
  renderKindChips();
  renderRepoChips();
  applyFilter();
  resetView(true);
});
$("mem-tag-q").addEventListener("input", (e) => {
  GAL.tagQuery = e.target.value.trim().toLowerCase();
  renderTagPicker();
});

$("mem-tags").addEventListener("click", (e) => {
  const off = e.target.closest("[data-tag-off]");
  if (off) { GAL.filter.tags.delete(off.dataset.tagOff); applyFilter(); return; }
  const on = e.target.closest("[data-tag]");
  if (on) { GAL.filter.tags.add(on.dataset.tag); applyFilter(); }
});
$("mem-kinds").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-kind]");
  if (!chip) return;
  const kind = chip.dataset.kind;
  if (GAL.filter.kinds.has(kind)) GAL.filter.kinds.delete(kind);
  else GAL.filter.kinds.add(kind);
  renderKindChips();
  applyFilter();
});
$("mem-repos").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-repo]");
  if (!chip) return;
  GAL.filter.repo = GAL.filter.repo === chip.dataset.repo ? "" : chip.dataset.repo;
  renderRepoChips();
  applyFilter();
});

for (const container of [$("claim-list"), $("mem-detail")]) {
  container.addEventListener("click", (e) => {
    const tag = e.target.closest("[data-tag]");
    if (tag) { GAL.filter.tags.add(tag.dataset.tag); applyFilter(); return; }
    const row = e.target.closest("[data-claim]");
    if (row) selectClaim(row.dataset.claim, true);
  });
}

if (window.ResizeObserver) new ResizeObserver(resizeGalaxy).observe($("galaxy-wrap"));
requestAnimationFrame(galaxyFrame);
