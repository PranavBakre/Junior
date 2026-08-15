function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  const el = $("view-" + view);
  (el || $("view-overview")).classList.add("active");
  if (view === "pipelines") {
    const pipelineId = hashQuery().get("id");
    if (pipelineId && !pipelineDetailErrors.has(pipelineId)) selectedPipelineId = pipelineId;
    if (pipelineViewMode === "topology") {
      resizePipeline();
      invalidatePipeline();
    }
    if (pipelines.length || selectedPipelineId) renderPipelines();
    void loadPipelineSpend();
  }
  if (view === "workflows") {
    const name = hashQuery().get("name");
    if (name) {
      selectedWorkflowName = name;
      workflowScrollPending = true;
    } else {
      selectedWorkflowName = null;
    }
    renderWorkflows();
  }
  if (view === "memory") { resizeGalaxy(); if (!galaxyLoaded) loadGalaxy(false); }
  if (view === "profiles" && !profilesLoaded) loadProfiles();
  if (view === "docs" && !docsLoaded) loadDocsTree();
  if (view === "logs") fetchLogs();
  if (view === "spend") loadSpend();
  if (view === "runbooks" && !runbooksLoaded) loadRunbooks();
  if (view === "audit") loadAudit();
}
window.addEventListener("hashchange", () => show(currentView()));

$("live-toggle").addEventListener("click", () => {
  live = !live;
  $("live-dot").classList.toggle("paused", !live);
  $("live-label").textContent = live ? "live · 2s poll" : "paused";
});

/* =================== sidebar / header =================== */
function setNavCount(id, n, cls) {
  const el = $(id);
  if (!el) return;
  if (n == null || n === 0 && id === "nav-logs") {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  if (id === "nav-logs" && n <= 0) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.textContent = String(n);
  el.className = "count" + (cls ? " " + cls : "");
}

function renderSidebar() {
  const s = (health && health.sessions) || {};
  const total = s.total ?? sessions.length;
  const busy = s.busy ?? sessions.filter((x) => x.status === "busy").length;
  setNavCount("nav-threads", total, busy > 0 ? "hot" : "");
  setNavCount("nav-logs", logErrorCount, logErrorCount > 0 ? "err" : "");
  const running = devServers.filter((d) => d.running).length;
  setNavCount("nav-ds", running, "");
  const enabled = workflows.filter((w) => w.enabled).length;
  setNavCount("nav-wf", enabled, "");
  setNavCount(
    "nav-pipelines",
    openPipelineCount,
    openPipelineCount > 0 ? "hot" : "",
  );
  const eventsToday = health && health.spend ? health.spend.eventsToday : 0;
  setNavCount("nav-spend", eventsToday, "");
  const writesToday = health && health.audit ? health.audit.writesToday : 0;
  setNavCount("nav-audit", writesToday, writesToday > 0 ? "hot" : "");
  if (runbooksLoaded) setNavCount("nav-runbooks", runbooks.length, "");

  // Static side-foot DOM — only update text nodes (live-toggle keeps one listener).
  $("sf-version").textContent = health ? String(health.version || "—") : "—";
  $("sf-uptime").textContent = health ? fmtUptime(health.uptime) : "—";
  $("sf-repos").textContent = health && health.repos && health.repos.length
    ? health.repos.join(", ")
    : "—";
}

/* =================== overview =================== */
function deriveAttention() {
  const cards = [];
  for (const s of sessions) {
    if (s.status === "error" || s.lastError) {
      const msg = s.lastError
        ? (s.lastError.type + ": " + s.lastError.message)
        : "session in error state";
      cards.push({
        sev: "err",
        kind: "session error",
        title: (s.channel || "thread") + " · " + (s.lastError ? s.lastError.type : "error"),
        desc: msg + " — thread " + shortId(s.threadId),
        view: "threads",
        threadId: s.threadId,
      });
    }
  }
  for (const s of sessions) {
    if (s.status === "busy" && s.lastActivity && (Date.now() - s.lastActivity) > STUCK_MS) {
      cards.push({
        sev: "warn",
        kind: "possible stall",
        title: (s.channel || "thread") + " · possibly stuck",
        desc: "busy with no activity for " + ago(s.lastActivity) + " — thread " + shortId(s.threadId),
        view: "threads",
        threadId: s.threadId,
      });
    }
  }
  for (const d of devServers) {
    const waiters = d.waiters || [];
    if (waiters.length > 0) {
      const next = waiters[0];
      cards.push({
        sev: "warn",
        kind: "dev-server queue",
        title: d.repo + " · " + waiters.length + " waiting",
        desc: (d.holder
          ? "holder " + shortId(d.holder.holderThreadId) + " for " + ago(d.holder.acquiredAt)
          : "no holder") +
          (next ? " — next: " + (next.branch || shortId(next.threadId)) : ""),
        view: "devservers",
      });
    }
  }
  for (const run of attentionPipelines) {
    if (run.status === "needs-human") {
      cards.push({
        sev: "warn",
        kind: "pipeline needs human",
        title: (run.kind || "pipeline") + " · " + (run.phase || "needs-human"),
        desc: (run.lastOutcomeSummary || "A pipeline is waiting on a human.") +
          " — " + shortId(run.id),
        view: "pipelines",
        pipelineId: run.id,
      });
    }
  }
  for (const w of workflows) {
    const state = w.state || {};
    const runs = w.runs || [];
    const latest = runs[0];
    const failed = latest && (latest.status === "failed" || latest.status === "error");
    if (state.lastError || failed) {
      cards.push({
        sev: "warn",
        kind: "workflow",
        title: w.name + (failed ? " · last run failed" : " · error"),
        desc: state.lastError || (latest && latest.error) || "latest run failed",
        view: "workflows",
      });
    }
  }
  return cards;
}

function renderOverview() {
  if (lastRefreshAt) {
    $("ov-refreshed").textContent = "refreshed " + ago(lastRefreshAt) + " ago";
  }
  const cards = deriveAttention();
  $("attn-sect").textContent = "Needs attention" + (cards.length ? " · " + cards.length : "");
  if (cards.length === 0) {
    $("attn").innerHTML = "";
    $("attn-ok").style.display = "block";
  } else {
    $("attn-ok").style.display = "none";
    $("attn").innerHTML = cards.map((a) =>
      '<div class="attn-card sev-' + a.sev + '" data-view="' + esc(a.view) + '"' +
      (a.threadId ? ' data-thread="' + esc(a.threadId) + '"' : "") +
      (a.pipelineId ? ' data-pipeline="' + esc(a.pipelineId) + '"' : "") + ">" +
      '<div class="kind">' + (a.sev === "err" ? "✕" : "△") + " " + esc(a.kind) + "</div>" +
      '<div class="t">' + esc(a.title) + '</div><div class="d">' + esc(a.desc) + "</div>" +
      '<span class="go">→</span></div>'
    ).join("");
  }

  const s = (health && health.sessions) || {};
  const a = (health && health.agents) || {};
  const buffered = sessions.reduce((n, x) => n + pendingCount(x.pendingMessages), 0);
  const stuck = sessions.filter((x) => x.status === "busy" && x.lastActivity && Date.now() - x.lastActivity > STUCK_MS).length;
  const running = devServers.filter((d) => d.running).length;
  const stats = [
    ["Threads", s.total ?? sessions.length, "", "active window"],
    ["Busy", s.busy ?? 0, (s.busy ?? 0) > 0 ? "busy" : "", stuck ? stuck + " possibly stuck" : "ok"],
    ["Errors", s.errors ?? sessions.filter(isErrorSession).length, (s.errors ?? 0) > 0 ? "err" : "", "with lastError"],
    ["Agents busy", a.busy ?? 0, (a.busy ?? 0) > 0 ? "busy" : "", "of " + (a.total ?? 0) + " sessions"],
    ["Buffered msgs", buffered, "", "across threads"],
    ["Dev servers", running, "", "of " + devServers.length + " repos"],
  ];
  const todayTotals = spendToday && spendToday.totals;
  const todayCost = todayTotals ? fmtProviderCost(todayTotals.costUsd) : null;
  stats.push([
    "Today tokens",
    todayTotals ? fmtTokens(spendTotalTokens(todayTotals)) : "—",
    "",
    todayTotals
      ? (todayCost ? todayCost + " provider-reported" : "tokens only")
      : "host-local today",
  ]);
  $("ov-stats").innerHTML = stats.map(([lbl, num, cls, sub]) =>
    '<div class="stat"><div class="lbl">' + esc(lbl) + '</div><div class="num ' + esc(cls) + '">' +
    esc(num) + '</div><div class="sub">' + esc(sub) + "</div></div>"
  ).join("");

  // activity strip
  if (actBuckets && actBuckets.some((v) => v > 0)) {
    $("act-section").style.display = "";
    const max = Math.max(...actBuckets, 1);
    const nowH = new Date().getUTCHours();
    $("act-chart").innerHTML = actBuckets.map((v, i) =>
      '<div class="act-bar' + (i === nowH ? " now" : "") + '" data-h="' + i + '" data-v="' + v +
      '" style="height:' + Math.max(4, (v / max) * 100) + '%"></div>'
    ).join("");
  } else {
    $("act-section").style.display = "none";
  }

  // feed (from slow full-day log cadence — not the Logs-view tail)
  const feed = dayLogEntries.filter((e) => e.level === "WARN" || e.level === "ERROR").slice(-8).reverse();
  if (dayLogError && feed.length === 0) {
    $("ov-feed").innerHTML = '<div class="empty">Could not load logs.</div>';
  } else if (feed.length === 0) {
    $("ov-feed").innerHTML = '<div class="empty">No warnings or errors today.</div>';
  } else {
    $("ov-feed").innerHTML = feed.map((e) =>
      '<div class="feed-row"><span class="faint">' + esc(timeOf(e.timestamp)) +
      '</span><span class="lv ' + esc(e.level) + '">' + esc(e.level) +
      '</span><span class="msg" title="' + esc(e.message) + '">' + esc(e.message) + "</span></div>"
    ).join("");
  }

  // busiest: non-idle, by lastActivity desc already
  const busyish = sessions.filter((t) => t.status !== "idle").slice(0, 8);
  if (busyish.length === 0) {
    $("ov-busiest").innerHTML = '<div class="empty">No busy or draining threads.</div>';
  } else {
    $("ov-busiest").innerHTML = busyish.map((t) =>
      '<div class="feed-row" style="grid-template-columns: 1fr auto auto; cursor:pointer" data-open-thread="' + esc(t.threadId) + '">' +
      '<span class="msg"><b style="color:var(--fg)">' + esc(t.channel || "—") + '</b> · ' +
      esc(shortId(t.threadId)) + "</span>" + pill(t.status) +
      '<span class="faint">' + ago(t.lastActivity) + " ago</span></div>"
    ).join("");
  }
}

$("attn").addEventListener("click", (e) => {
  const card = e.target.closest(".attn-card");
  if (!card) return;
  if (card.dataset.thread) {
    location.hash = "threads";
    openDrawer(card.dataset.thread);
  } else if (card.dataset.pipeline) {
    selectedPipelineId = card.dataset.pipeline;
    location.hash = "pipelines";
  } else if (card.dataset.view) {
    location.hash = card.dataset.view;
  }
});
$("ov-busiest").addEventListener("click", (e) => {
  const row = e.target.closest("[data-open-thread]");
  if (row) openDrawer(row.dataset.openThread);
});
const actTip = $("act-tip");
$("act-chart").addEventListener("mousemove", (e) => {
  const bar = e.target.closest(".act-bar");
  if (!bar) { actTip.style.display = "none"; return; }
  actTip.textContent = String(bar.dataset.h).padStart(2, "0") + ":00 · " + bar.dataset.v + " turns";
  actTip.style.display = "block";
  const wrap = bar.closest(".act-wrap").getBoundingClientRect();
  const r = bar.getBoundingClientRect();
  actTip.style.left = Math.min(wrap.width - 130, r.left - wrap.left) + "px";
  actTip.style.top = (r.top - wrap.top - 34) + "px";
});
$("act-chart").addEventListener("mouseleave", () => { actTip.style.display = "none"; });

/* =================== logs =================== */
function renderLogs() {
  if (logFetchError) {
    $("log-lines").innerHTML = '<div class="empty">Failed to load logs.</div>';
    $("log-count").textContent = "";
    return;
  }
  const rows = logEntries.filter((e) => {
    if (logLevel && e.level !== logLevel) return false;
    if (logQuery) {
      const hay = ((e.tag || "") + " " + (e.message || "")).toLowerCase();
      if (!hay.includes(logQuery)) return false;
    }
    return true;
  });
  $("log-lines").innerHTML = rows.length
    ? rows.map((e) =>
        '<div class="log-line' +
        (e.level === "ERROR" ? " is-error" : e.level === "WARN" ? " is-warn" : "") + '">' +
        '<span class="ts">' + esc(timeOf(e.timestamp)) + '</span>' +
        '<span class="lv ' + esc(e.level) + '">' + esc(e.level) + "</span>" +
        '<span class="tag">[' + esc(e.tag) + ']</span>' +
        '<span class="msg">' + esc(e.message) + "</span></div>"
      ).join("")
    : '<div class="empty">Nothing matches the current filters.</div>';
  const date = $("log-date").value || todayISO();
  $("log-count").textContent =
    rows.length + " / " + logEntries.length + " lines · " + date + ".log" +
    (follow ? " · following" : "");
}

async function fetchLogs() {
  const date = $("log-date").value || todayISO();
  const tag = $("log-tag").value;
  let path = "/api/logs?date=" + encodeURIComponent(date) + "&tail=400";
  if (tag) path += "&tag=" + encodeURIComponent(tag);
  if (logLevel) path += "&level=" + encodeURIComponent(logLevel);
  const res = await safeFetch(path);
  if (!res.ok) {
    logFetchError = res.error;
    logEntries = [];
    renderLogs();
    return;
  }
  logFetchError = null;
  logEntries = res.data.entries || [];
  // client-side grep only; server already filtered tag/level
  renderLogs();
  if (follow && $("view-logs").classList.contains("active")) {
    const panel = $("log-scroll");
    if (panel) panel.scrollTop = panel.scrollHeight;
  }
}

// init date
$("log-date").value = todayISO();
$("log-levels").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#log-levels .chip").forEach((c) => c.classList.remove("on"));
  chip.classList.add("on");
  logLevel = chip.dataset.lv || "";
  fetchLogs();
});
$("log-tag").addEventListener("change", () => fetchLogs());
$("log-date").addEventListener("change", () => fetchLogs());
$("log-search").addEventListener("input", (e) => {
  logQuery = e.target.value.toLowerCase();
  renderLogs();
});
$("log-clear").addEventListener("click", () => {
  logLevel = "";
  logQuery = "";
  $("log-tag").value = "";
  $("log-search").value = "";
  $("log-date").value = todayISO();
  document.querySelectorAll("#log-levels .chip").forEach((c) =>
    c.classList.toggle("on", c.dataset.lv === "")
  );
  fetchLogs();
});
$("log-follow").addEventListener("click", (e) => {
  follow = !follow;
  e.currentTarget.classList.toggle("on", follow);
  e.currentTarget.textContent = follow ? "● follow" : "○ follow";
});

/* =================== dev servers =================== */
function renderDevServers() {
  if (!devServers.length) {
    $("ds-grid").innerHTML = '<div class="empty">No repos with devCommand configured.</div>';
    return;
  }
  const ttl = idleTtlMs || 20 * 60000;
  $("ds-grid").innerHTML = devServers.map((d) => {
    const rem = d.idleMsRemaining;
    const pct = d.running && rem != null ? Math.round((rem / ttl) * 100) : 0;
    const meter = d.running
      ? '<div class="mrow"><span>idle TTL</span><span>' +
        (rem != null ? Math.round(rem / 60000) + "m of " + Math.round(ttl / 60000) + "m" : "—") +
        "</span></div>" +
        '<div class="meter"><div class="fill' + (pct < 25 ? " low" : "") +
        '" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div>'
      : "";
    const holder = d.holder
      ? '<div class="qrow"><span class="pos">held</span><code>' +
        esc(shortId(d.holder.holderThreadId)) + "</code><span>acquired " +
        ago(d.holder.acquiredAt) + " ago</span></div>"
      : '<div class="qrow faint"><span class="pos">—</span>no holder</div>';
    const waiters = (d.waiters || []).map((w, i) =>
      '<div class="qrow"><span class="pos">#' + (i + 1) + "</span><code>" +
      esc(shortId(w.threadId)) + "</code><span>→ " + esc(w.branch || "—") +
      '</span><span class="faint" style="margin-left:auto">' + ago(w.enqueuedAt) + "</span></div>"
    ).join("");
    return (
      '<div class="ds-card"><div class="top"><b>' + esc(d.repo) + "</b>" +
      (d.running ? pill("running") : pill("stopped")) +
      (d.branch ? "<code>" + esc(d.branch) + "</code>" : "") + "</div>" +
      '<div class="cmd">' + esc(d.devCommand || "—") +
      (d.devPort ? " · :" + d.devPort : "") +
      (d.pid ? " · pid " + d.pid : "") + "</div>" +
      meter + holder + waiters + "</div>"
    );
  }).join("");
}

/* =================== profiles =================== */
const PROFILE_KINDS = ["person", "repo", "project", "situation"];

async function loadProfiles() {
  const res = await safeFetch("/api/profiles");
  profilesLoaded = true;
  if (!res.ok) {
    $("profile-list").innerHTML = '<div class="empty">Failed to load profiles.</div>';
    $("profile-detail").innerHTML = '<div class="empty">Profile store unavailable.</div>';
    return;
  }
  profiles = res.data.profiles || [];
  const counts = res.data.counts || {};
  const total = profiles.length;
  setNavCount("nav-profiles", total, "");
  $("profile-stats").innerHTML = PROFILE_KINDS.map((kind) =>
    '<div class="profile-stat"><span class="n">' + esc(counts[kind] || 0) + '</span><span class="k">' + esc(kind) + '</span></div>'
  ).join("");
  renderProfileKinds(counts);
  renderProfiles();
}

function renderProfileKinds(counts = null) {
  const totals = counts || Object.fromEntries(PROFILE_KINDS.map((kind) => [kind, profiles.filter((p) => p.kind === kind).length]));
  $("profile-kinds").innerHTML = ["all", ...PROFILE_KINDS].map((kind) => {
    const count = kind === "all" ? profiles.length : totals[kind] || 0;
    return '<span class="chip' + (profileKind === kind ? " on" : "") + '" data-profile-kind="' + kind + '">' + kind + ' · ' + count + '</span>';
  }).join("");
}

function filteredProfiles() {
  return profiles.filter((profile) => {
    if (profileKind !== "all" && profile.kind !== profileKind) return false;
    if (!profileQuery) return true;
    return JSON.stringify(profile).toLowerCase().includes(profileQuery);
  });
}

function profileTitle(profile) {
  return String(profile.entity_ref || "unknown").split(":")[0].replaceAll("-", " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function renderProfiles() {
  const visible = filteredProfiles();
  if (!visible.length) {
    $("profile-list").innerHTML = '<div class="empty">No profiles match this filter.</div>';
    $("profile-detail").innerHTML = '<div class="empty">Nothing selected.</div>';
    selectedProfileRef = null;
    return;
  }
  if (!visible.some((profile) => profile.entity_ref === selectedProfileRef)) {
    selectedProfileRef = visible[0].entity_ref;
  }
  $("profile-list").innerHTML = visible.map((profile) =>
    '<button class="profile-row' + (profile.entity_ref === selectedProfileRef ? " on" : "") + '" type="button" data-profile-ref="' + esc(profile.entity_ref) + '">' +
      '<span class="title">' + esc(profileTitle(profile)) + '</span>' +
      '<span class="meta"><span class="profile-kind">' + esc(profile.kind) + '</span><span>updated ' + esc(profile.updated_at || "—") + '</span><span>' + esc((profile.evidence || []).length) + ' sources</span></span>' +
    '</button>'
  ).join("");
  renderProfileDetail(visible.find((profile) => profile.entity_ref === selectedProfileRef));
}

function renderProfileDetail(profile) {
  if (!profile) {
    $("profile-detail").innerHTML = '<div class="empty">Select a profile.</div>';
    return;
  }
  const hidden = new Set(["kind", "entity_ref", "body", "evidence", "updated_at", "last_used_at"]);
  const fields = Object.entries(profile).filter(([key, value]) =>
    !hidden.has(key) && value != null && (!Array.isArray(value) || value.length > 0) && value !== ""
  );
  $("profile-detail").innerHTML =
    '<div><span class="profile-kind">' + esc(profile.kind) + '</span><h3>' + esc(profileTitle(profile)) + '</h3><div class="ref">' + esc(profile.entity_ref) + ' · updated ' + esc(profile.updated_at || "—") + '</div></div>' +
    (fields.length ? '<div class="profile-fields">' + fields.map(([key, value]) =>
      '<div class="profile-field"><div class="label">' + esc(key.replaceAll("_", " ")) + '</div><div class="value">' + esc(Array.isArray(value) ? value.join("\n") : value) + '</div></div>'
    ).join("") + '</div>' : '') +
    '<div class="profile-body">' + (profile.body ? renderMarkdown(profile.body) : '<span class="faint">No narrative sketch.</span>') + '</div>' +
    '<div class="profile-evidence">evidence · ' + esc((profile.evidence || []).length) + ' source record(s)' +
      (profile.last_used_at ? ' · recalled ' + esc(ago(profile.last_used_at)) + ' ago' : ' · never recalled') + '</div>';
}

$("profile-kinds").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-profile-kind]");
  if (!chip) return;
  profileKind = chip.dataset.profileKind;
  renderProfileKinds();
  renderProfiles();
});
$("profile-search").addEventListener("input", (event) => {
  profileQuery = event.target.value.trim().toLowerCase();
  renderProfiles();
});
$("profile-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-profile-ref]");
  if (!row) return;
  selectedProfileRef = row.dataset.profileRef;
  renderProfiles();
});

/* =================== docs =================== */
async function loadDocsTree() {
  const res = await safeFetch("/api/memory");
  docsLoaded = true;
  if (!res.ok) {
    $("doc-tree").innerHTML = '<div class="empty">Failed to load docs tree.</div>';
    return;
  }
  const files = res.data.files || [];
  if (!files.length) {
    $("doc-tree").innerHTML = '<div class="empty">No markdown files under docs/.</div>';
    return;
  }
  // group by top-level dir
  const groups = {};
  for (const f of files) {
    const parts = f.split("/");
    const dir = parts.length > 1 ? parts[0] : ".";
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  }
  let html = "";
  for (const dir of Object.keys(groups).sort()) {
    html += '<div class="doc-dir">' + esc(dir === "." ? "docs" : dir) + "/</div>";
    for (const f of groups[dir]) {
      const name = f.includes("/") ? f.slice(f.indexOf("/") + 1) : f;
      html += '<span class="doc-file" data-p="' + esc(f) + '">' + esc(name) + "</span>";
    }
  }
  $("doc-tree").innerHTML = html;
  // open first feature doc if present
  const prefer = files.find((f) => f.includes("http-dashboard")) || files[0];
  if (prefer) openDoc(prefer);
}
async function openDoc(p) {
  document.querySelectorAll(".doc-file").forEach((el) =>
    el.classList.toggle("on", el.dataset.p === p)
  );
  $("doc-pane").innerHTML = '<div class="empty">loading…</div>';
  const res = await safeFetch("/api/memory/" + p.split("/").map(encodeURIComponent).join("/"));
  if (!res.ok) {
    $("doc-pane").innerHTML = '<div class="empty">Failed to load ' + esc(p) + "</div>";
    return;
  }
  $("doc-pane").innerHTML = renderMarkdown(res.data.content || "");
}
$("doc-tree").addEventListener("click", (e) => {
  const f = e.target.closest(".doc-file");
  if (f) openDoc(f.dataset.p);
});

// boot — initial show AFTER all const/let bindings exist (avoids TDZ on #memory deep-link)
show(currentView());
tick();
setInterval(tick, POLL_MS);
refreshDayLogs();
setInterval(() => { if (live) refreshDayLogs(); }, LOG_SLOW_MS);
