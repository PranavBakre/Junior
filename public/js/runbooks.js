/* =================== runbooks =================== */
var RUNBOOK_RISKS = [
  "read-only",
  "workspace-write",
  "production-write",
  "destructive",
  "credential",
  "privacy-sensitive",
  "payment",
  "access-control",
];
var RUNBOOK_EMPTY = "No runbooks loaded. Private overlay `agents-org/runbooks/` is empty or not mounted.";

function runbookRiskChip(risk) {
  const st = risk || "unknown";
  return '<span class="pill ' + esc(st) + '">' + esc(st) + "</span>";
}

function filteredRunbooks() {
  return runbooks.filter((rb) => {
    if (runbookRisk && rb.risk !== runbookRisk) return false;
    if (!runbookQuery) return true;
    const hay = [
      rb.name,
      rb.description,
      rb.ownerAgent,
      (rb.tags || []).join(" "),
    ].join(" ").toLowerCase();
    return hay.includes(runbookQuery);
  });
}

function renderRunbookRisks() {
  const visible = runbooks;
  const counts = { all: visible.length };
  for (const risk of RUNBOOK_RISKS) counts[risk] = 0;
  for (const rb of visible) {
    if (counts[rb.risk] != null) counts[rb.risk] += 1;
  }
  $("rb-risks").innerHTML = ["all", ...RUNBOOK_RISKS].map((risk) => {
    const count = risk === "all" ? counts.all : counts[risk] || 0;
    const on = (risk === "all" && !runbookRisk) || runbookRisk === risk;
    const hot = risk === "production-write" || risk === "destructive" ? " risk-hot" : "";
    return (
      '<span class="chip' + (on ? " on" : "") + hot + '" data-rb-risk="' + (risk === "all" ? "" : risk) + '">' +
      risk + " · " + count + "</span>"
    );
  }).join("");
}

function formatRunbookInputs(inputs) {
  if (!inputs || !inputs.length) return "none";
  return inputs.map((input) => {
    const req = input.required ? "required" : "optional";
    const en = input.enumValues && input.enumValues.length
      ? " [" + input.enumValues.join(", ") + "]"
      : "";
    return input.name + ": " + (input.type || "string") + " (" + req + ")" + en;
  }).join("\n");
}

function formatApproval(approval) {
  if (!approval) return "—";
  const after = (approval.afterSteps || []).join(", ");
  return (approval.required ? "required" : "not required") + (after ? "\nafter: " + after : "");
}

function formatVerification(verification) {
  if (!verification) return "—";
  const assertions = (verification.assertions || []).join("\n");
  return (verification.required ? "required" : "not required") + (assertions ? "\n" + assertions : "");
}

function formatPct(rate) {
  if (rate == null || !Number.isFinite(Number(rate))) return "—";
  return Math.round(Number(rate) * 100) + "%";
}

function renderRunbookList() {
  const visible = filteredRunbooks();
  if (!runbooks.length) {
    $("rb-list").innerHTML = '<div class="empty">' + esc(RUNBOOK_EMPTY) + "</div>";
    $("rb-detail").innerHTML = '<div class="empty">' + esc(RUNBOOK_EMPTY) + "</div>";
    selectedRunbookName = null;
    return;
  }
  if (!visible.length) {
    $("rb-list").innerHTML = '<div class="empty">No runbooks match this filter.</div>';
    $("rb-detail").innerHTML = '<div class="empty">Nothing selected.</div>';
    selectedRunbookName = null;
    return;
  }
  if (!visible.some((rb) => rb.name === selectedRunbookName)) {
    selectedRunbookName = visible[0].name;
  }
  $("rb-list").innerHTML = visible.map((rb) =>
    '<button class="profile-row' + (rb.name === selectedRunbookName ? " on" : "") +
    '" type="button" data-runbook="' + esc(rb.name) + '">' +
      '<span class="title">' + esc(rb.name) + "</span>" +
      '<span class="meta">' + runbookRiskChip(rb.risk) +
      "<span>" + esc(rb.ownerAgent || "—") + "</span>" +
      ((rb.tags || []).length ? "<span>" + esc(rb.tags.join(", ")) + "</span>" : "") +
      "</span>" +
    "</button>"
  ).join("");
}

function renderRunbookDetail(payload) {
  if (runbookDetailError) {
    $("rb-detail").innerHTML = '<div class="empty">Failed to load runbook. Retry.</div>';
    return;
  }
  if (!payload || !payload.runbook) {
    $("rb-detail").innerHTML = '<div class="empty">Select a runbook.</div>';
    return;
  }
  const rb = payload.runbook;
  const git = payload.git || {};
  const metrics = payload.metrics;
  const copyPath = "agents-org/runbooks/" + rb.name + ".runbook.md";
  const absPath = git.path || rb.filePath || "";
  const fields = [
    ["owner", rb.ownerAgent || "—"],
    ["risk", rb.risk || "—"],
    ["inputs", formatRunbookInputs(rb.inputs)],
    ["approval", formatApproval(rb.approval)],
    ["verification", formatVerification(rb.verification)],
    ["capabilities", (rb.capabilities || []).join("\n") || "none"],
    ["tags", (rb.tags || []).join(", ") || "none"],
    ["origin", rb.origin || "—"],
  ];
  const metricStrip = metrics
    ? '<div class="stat-grid" style="margin:18px 0 8px">' +
      [
        ["selections", metrics.selectionCount],
        ["completed", metrics.completionCount],
        ["failed", metrics.failureCount],
        ["gate", formatPct(metrics.gateComplianceRate)],
        ["verified", formatPct(metrics.verificationSuccessRate)],
        ["last used", metrics.lastUsedAt ? ago(metrics.lastUsedAt) + " ago" : "never"],
      ].map(([lbl, val]) =>
        '<div class="stat"><div class="lbl">' + esc(lbl) + '</div><div class="num">' +
        esc(val) + "</div></div>"
      ).join("") +
      "</div>"
    : '<div class="faint" style="margin:14px 0">No catalogue metrics yet.</div>';
  $("rb-detail").innerHTML =
    "<div>" + runbookRiskChip(rb.risk) +
    "<h3>" + esc(rb.name) + "</h3>" +
    '<div class="ref">' + esc(rb.description || "no description") + "</div></div>" +
    '<div class="profile-fields">' + fields.map(([label, value]) =>
      '<div class="profile-field"><div class="label">' + esc(label) +
      '</div><div class="value">' + esc(value) + "</div></div>"
    ).join("") + "</div>" +
    '<div class="profile-body">' +
    (rb.prompt ? renderMarkdown(rb.prompt) : '<span class="faint">No prompt body.</span>') +
    "</div>" +
    '<h3 class="sect">Provenance</h3>' +
    '<div class="kv">' +
    '<span class="k">repo</span><span>' + esc(git.repo || rb.origin || "—") + "</span>" +
    '<span class="k">path</span><span class="mono" style="font-size:calc(11 * var(--baseline-font))">' + esc(absPath || copyPath) + "</span>" +
    '<span class="k">SHA</span><code>' + esc(git.commitSha || "—") + "</code>" +
    '<span class="k">digest</span><code>' + esc(git.contentDigest || rb.contentDigest || "—") + "</code>" +
    "</div>" +
    '<h3 class="sect">Metrics</h3>' + metricStrip +
    '<div class="profile-evidence">copy path · <code id="rb-path">' + esc(copyPath) + "</code> " +
    '<button class="copy-btn" type="button" data-cmd="' + esc(copyPath) + '">copy</button>' +
    (absPath && absPath !== copyPath
      ? '<div class="faint" style="margin-top:4px">' + esc(absPath) + "</div>"
      : "") +
    "</div>";
}

function renderRunbooks() {
  renderRunbookRisks();
  renderRunbookList();
  if (runbookErrors.length) {
    $("rb-list").innerHTML +=
      '<div class="empty" style="color:var(--red)">Load errors: ' +
      runbookErrors.map((err) => esc(err.path) + " — " + esc(err.message)).join("; ") +
      "</div>";
  }
  if (runbookDetail && runbookDetail.runbook && runbookDetail.runbook.name === selectedRunbookName) {
    renderRunbookDetail(runbookDetail);
  } else if (selectedRunbookName) {
    loadRunbookDetail(selectedRunbookName);
  }
}

async function loadRunbooks() {
  const res = await safeFetch("/api/runbooks?limit=100");
  runbooksLoaded = true;
  if (!res.ok) {
    $("rb-list").innerHTML = '<div class="empty">Failed to load runbooks.</div>';
    $("rb-detail").innerHTML = '<div class="empty">Failed to load runbooks.</div>';
    return;
  }
  runbooks = res.data.runbooks || [];
  runbookErrors = res.data.errors || [];
  setNavCount("nav-runbooks", runbooks.length, "");
  renderRunbooks();
}

async function loadRunbookDetail(name) {
  if (!name) {
    renderRunbookDetail(null);
    return;
  }
  $("rb-detail").innerHTML = '<div class="empty">loading…</div>';
  const res = await safeFetch("/api/runbooks/" + encodeURIComponent(name));
  if (selectedRunbookName !== name) return;
  if (!res.ok) {
    runbookDetail = null;
    runbookDetailError = res.error || true;
    renderRunbookDetail(null);
    return;
  }
  runbookDetailError = null;
  runbookDetail = res.data;
  renderRunbookDetail(runbookDetail);
}

$("rb-risks").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-rb-risk]");
  if (!chip) return;
  runbookRisk = chip.dataset.rbRisk || "";
  renderRunbooks();
});
$("rb-search").addEventListener("input", (event) => {
  runbookQuery = event.target.value.trim().toLowerCase();
  renderRunbooks();
});
$("rb-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-runbook]");
  if (!row) return;
  selectedRunbookName = row.dataset.runbook;
  renderRunbookList();
  loadRunbookDetail(selectedRunbookName);
});
