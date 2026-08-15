/* =================== helpers =================== */
var POLL_MS = 2000;
var STUCK_MS = 15 * 60 * 1000;
var $ = (id) => document.getElementById(id);
var esc = (s) => s == null ? "" : String(s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function shortId(id) {
  if (!id) return "—";
  const s = String(id);
  return s.length > 16 ? s.slice(0, 10) + "…" + s.slice(-4) : s;
}
function ago(ts) {
  if (ts == null) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  const mm = Math.floor(s / 60);
  if (mm < 60) return mm + "m";
  const h = Math.floor(mm / 60);
  if (h < 24) return h + "h " + (mm % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}
function fmtUptime(sec) {
  if (sec == null) return "—";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + (s % 60) + "s";
  return (s % 60) + "s";
}
function fmtRemaining(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m + "m " + String(s % 60).padStart(2, "0") + "s";
}
function fmtNext(ts) {
  if (!ts) return "—";
  const mins = Math.round((ts - Date.now()) / 60000);
  if (mins < 0) return "overdue";
  if (mins < 60) return "in " + mins + "m";
  return "in " + Math.floor(mins / 60) + "h " + (mins % 60) + "m";
}
function pill(status) {
  const st = status || "unknown";
  return '<span class="pill ' + esc(st) + '">' + esc(st) + "</span>";
}
function todayISO() {
  // Log files are named by UTC date (src/logger.ts uses toISOString().slice(0, 10)).
  return new Date().toISOString().slice(0, 10);
}
function timeOf(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // already HH:MM:SS or similar
    const m = String(iso).match(/(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : String(iso).slice(11, 19) || String(iso);
  }
  return String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0");
}
function pendingCount(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "number") return v;
  return 0;
}
function isErrorSession(s) {
  return s.status === "error" || !!(s.lastError);
}
function hashQuery() {
  return new URLSearchParams(location.hash.split("?")[1] || "");
}
function spendTotalTokens(totals) {
  if (!totals) return 0;
  return (Number(totals.inputTokens) || 0) + (Number(totals.outputTokens) || 0);
}
function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(v) >= 10_000) return Math.round(v / 1000) + "k";
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(v));
}
function fmtProviderCost(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return null;
  const n = Number(costUsd);
  if (n === 0) return null;
  if (n >= 0.01) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}
function formatSpendSummary(spend) {
  if (!spend) return "—";
  const turns = Number(spend.turns) || 0;
  const cost = fmtProviderCost(spend.costUsd);
  return fmtTokens(spendTotalTokens(spend)) + " tok · " + turns + " turn" +
    (turns === 1 ? "" : "s") + (cost ? " · " + cost + " provider-reported" : "");
}
async function fetchJson(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(path + " " + res.status);
  return await res.json();
}
async function safeFetch(path, init) {
  try {
    return { ok: true, data: await fetchJson(path, init) };
  } catch (err) {
    if (err?.name === "AbortError") return { ok: false, aborted: true, error: err, data: null };
    console.error("fetch failed", path, err);
    return { ok: false, error: err, data: null };
  }
}

/* =================== state =================== */
var live = true;
var lastRefreshAt = 0;
var health = null;
var sessions = [];
var devServers = [];
var idleTtlMs = null;
var workflows = [];
var workflowErrors = [];
var workflowWriteGit = { junior: null, overlay: null };
var overlayRootExists = false;
var pipelines = [];
var attentionPipelines = [];
var openPipelineCount = 0;
var pipelineRuntimeMode = null;
var pipelineDetails = new Map();
var pipelineDetailErrors = new Set();
var pipelineDetailLoadingId = null;
var pipelineDetailAbortController = null;
var pipelineFetchError = null;
var pipelineFetchGeneration = 0;
var selectedPipelineId = null;
var renderedPipelineListSignature = null;
var logEntries = [];
var logErrorCount = 0;
var logFetchError = null;
var dayLogEntries = []; // full-day log payload from slow cadence (overview/errors/turns)
var dayLogError = null;
var thFilter = "all";
var thQuery = "";
var logLevel = "";
var logQuery = "";
var follow = true;
var actBuckets = null; // length-24 or null to hide
var docsLoaded = false;
var galaxyLoaded = false;
var profilesLoaded = false;
var profiles = [];
var profileKind = "all";
var profileQuery = "";
var selectedProfileRef = null;
var drawerThreadId = null;
var spendToday = null;
var spendWeek = null;
var spendTable = null;
var spendGroupBy = "day";
var spendSortKey = "key";
var spendSortDir = "asc";
var spendError = null;
var spendFetchGeneration = 0;
var selectedWorkflowName = null;
var workflowScrollPending = false;
var pipelineSpendById = new Map();
var pipelineSpendGeneration = 0;
var runbooks = [];
var runbookErrors = [];
var runbooksLoaded = false;
var runbookQuery = "";
var runbookRisk = "";
var selectedRunbookName = null;
var runbookDetail = null;
var runbookDetailError = null;
var auditRows = [];
var auditLoaded = false;
var auditError = null;
var auditAction = "";
var auditTargetType = "";
var auditFrom = "";
var auditTo = "";
var auditFetchGeneration = 0;

/* =================== navigation =================== */
function currentView() {
  return (location.hash.slice(1) || "overview").split("?")[0];
}

/* =================== day logs (slow cadence) =================== */
var LOG_SLOW_MS = 30000;
function isTurnStartMessage(msg) {
  const m = String(msg || "");
  // Spec/mock phrasing; also match production init lines:
  // "thread=… agent=… provider=… sessionId=…"
  if (m.includes("turn started")) return true;
  return /\bthread=/.test(m) && /\bagent=/.test(m) && /\bsessionId=/.test(m);
}

/** One full-day log fetch (~30s). Derives ERROR badge, overview feed, turns buckets. */
async function refreshDayLogs() {
  const date = todayISO();
  const res = await safeFetch("/api/logs?date=" + encodeURIComponent(date) + "&tail=0");
  if (!res.ok) {
    dayLogError = res.error || true;
    renderSidebar();
    renderOverview();
    return;
  }
  dayLogError = null;
  const entries = res.data.entries || [];
  dayLogEntries = entries;
  logErrorCount = entries.filter((e) => e.level === "ERROR").length;

  const buckets = new Array(24).fill(0);
  for (const e of entries) {
    if (e.tag !== "session") continue;
    if (!isTurnStartMessage(e.message)) continue;
    const d = new Date(e.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    buckets[d.getUTCHours()]++;
  }
  actBuckets = buckets.some((v) => v > 0) ? buckets : null;

  renderSidebar();
  renderOverview();
}

/* =================== poll loop =================== */
function pipelineIncludeDefault() {
  const includeDefault = $("pipeline-include-default");
  return !!(includeDefault && includeDefault.checked);
}

function pipelineListPath() {
  const pipelineStatus = $("pipeline-filter").value;
  const pipelineKind = $("pipeline-kind").value;
  const pipelineParams = new URLSearchParams();
  if (pipelineStatus) pipelineParams.set("status", pipelineStatus);
  if (pipelineKind) pipelineParams.set("kind", pipelineKind);
  if (pipelineIncludeDefault()) pipelineParams.set("includeDefault", "1");
  return "/api/pipelines" +
    (pipelineParams.size ? "?" + pipelineParams.toString() : "");
}

function attentionPipelinePath() {
  const params = new URLSearchParams();
  params.set("status", "needs-human");
  if (pipelineIncludeDefault()) params.set("includeDefault", "1");
  return "/api/pipelines?" + params.toString();
}

function applyAttentionPipelineResponse(response) {
  if (response.ok) attentionPipelines = response.data.pipelines || [];
}

function applyPipelineListResponse(response) {
  if (response.ok) {
    pipelineFetchError = null;
    const nextPipelines = response.data.pipelines || [];
    openPipelineCount = Number(response.data.openCount) || 0;
    pipelineRuntimeMode = response.data.runtimeMode ?? null;
    for (const run of nextPipelines) {
      const detail = pipelineDetails.get(run.id);
      if (detail && detail.updatedAt !== run.updatedAt) pipelineDetails.delete(run.id);
    }
    pipelines = nextPipelines;
  } else {
    pipelineFetchError = response.error || true;
  }
}

async function refreshPipelineControlPlane() {
  const generation = ++pipelineFetchGeneration;
  const [response, attn] = await Promise.all([
    safeFetch(pipelineListPath()),
    safeFetch(attentionPipelinePath()),
  ]);
  if (generation !== pipelineFetchGeneration) return;
  applyPipelineListResponse(response);
  applyAttentionPipelineResponse(attn);
  renderSidebar();
  renderOverview();
  if (typeof renderPipelines === "function") renderPipelines();
  if (!response.ok && pipelines.length === 0) {
    $("pipeline-status").textContent = "Failed to load pipeline control plane.";
    $("pipeline-runs").innerHTML = '<div class="empty">Failed to load pipelines.</div>';
  }
}

async function refreshMain() {
  const pipelineGeneration = ++pipelineFetchGeneration;
  const [h, s, d, w, p, attn, spend] = await Promise.all([
    safeFetch("/api/health"),
    safeFetch("/api/sessions"),
    safeFetch("/api/dev-server"),
    safeFetch("/api/workflows"),
    safeFetch(pipelineListPath()),
    safeFetch(attentionPipelinePath()),
    safeFetch("/api/spend"),
  ]);

  if (h.ok) health = h.data;

  if (s.ok) sessions = s.data.sessions || [];
  if (d.ok) {
    devServers = d.data.devServers || [];
    idleTtlMs = d.data.idleTtlMs ?? idleTtlMs;
  }
  if (w.ok) {
    workflows = w.data.workflows || [];
    workflowErrors = w.data.errors || [];
    workflowWriteGit = w.data.git || workflowWriteGit;
    overlayRootExists = Boolean(w.data.overlayRootExists);
  }
  if (pipelineGeneration === pipelineFetchGeneration) {
    applyPipelineListResponse(p);
    applyAttentionPipelineResponse(attn);
  }
  if (spend.ok) spendToday = spend.data;

  lastRefreshAt = Date.now();
  renderSidebar();
  renderOverview();
  renderThreads();
  renderDevServers();
  renderWorkflows();
  if (currentView() === "pipelines") {
    if (typeof renderPipelines === "function") renderPipelines();
    if (typeof loadPipelineSpend === "function") await loadPipelineSpend();
  }
  if (currentView() === "spend") await loadSpend();
  if (currentView() === "runbooks" && runbooksLoaded) await loadRunbooks();
  if (currentView() === "audit") await loadAudit();
  // panel-level errors when first load fails
  if (!s.ok && sessions.length === 0) {
    $("th-list").innerHTML = '<div class="empty">Failed to load sessions.</div>';
    $("ov-busiest").innerHTML = '<div class="empty">Failed to load sessions.</div>';
  }
  if (!d.ok && devServers.length === 0) {
    $("ds-grid").innerHTML = '<div class="empty">Failed to load dev servers.</div>';
  }
  if (!w.ok && workflows.length === 0) {
    $("wf-list").innerHTML = '<div class="empty">Failed to load workflows.</div>';
  }
  if (!p.ok && pipelines.length === 0) {
    $("pipeline-status").textContent = "Failed to load pipeline control plane.";
    $("pipeline-runs").innerHTML = '<div class="empty">Failed to load pipelines.</div>';
  }
  if (!h.ok && !health) {
    $("ov-stats").innerHTML = '<div class="empty">Failed to load health.</div>';
  }
}

var tickInFlight = false;
async function tick() {
  if (!live || tickInFlight) return;
  tickInFlight = true;
  try {
    await refreshMain();
    if (currentView() === "logs" && follow) {
      await fetchLogs();
    }
  } catch (err) {
    console.error("poll tick failed", err);
  } finally {
    tickInFlight = false;
  }
}
