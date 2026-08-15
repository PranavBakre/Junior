/* =================== audit =================== */
function auditWhen(at) {
  if (at == null) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  return d.toLocaleString();
}

function renderAudit() {
  if (auditError && !auditRows.length) {
    $("audit-table").innerHTML = '<div class="empty">Failed to load audit log.</div>';
    return;
  }
  if (!auditRows.length) {
    $("audit-table").innerHTML =
      '<div class="audit-empty"><div class="audit-empty-icon" aria-hidden="true">⌁</div>' +
      '<div><strong>No dashboard changes yet</strong>' +
      '<p>This history fills when you continue or stop a thread, run or edit a workflow, ' +
      'or perform another dashboard mutation. Slack-originated actions are not duplicated here.</p></div></div>';
    return;
  }
  const rows = auditRows.map((row) =>
    "<tr>" +
    '<td class="num">' + esc(auditWhen(row.at)) + "</td>" +
    "<td>" + esc(row.actor || "—") + "</td>" +
    "<td>" + esc(row.action || "—") + "</td>" +
    "<td>" + esc(row.targetType || "—") + " · " + esc(row.targetId || "—") + "</td>" +
    "<td>" + pill(row.result || "unknown") + "</td>" +
    "<td>" + (row.error ? '<span style="color:var(--red)">' + esc(row.error) + "</span>" : "—") + "</td>" +
    '<td class="num">' + esc(row.slackTs || "—") + "</td>" +
    '<td class="mono">' + esc(row.commitSha ? shortId(row.commitSha) : "—") + "</td>" +
    "</tr>"
  ).join("");
  $("audit-table").innerHTML =
    '<table class="data-table"><thead><tr>' +
    "<th>when</th><th>actor</th><th>action</th><th>target</th><th>result</th><th>error</th><th>slack ts</th><th>commit</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>";
}

async function loadAudit() {
  const generation = ++auditFetchGeneration;
  const params = new URLSearchParams();
  if (auditAction) params.set("action", auditAction);
  if (auditTargetType) params.set("targetType", auditTargetType);
  if (auditFrom) params.set("from", auditFrom);
  if (auditTo) params.set("to", auditTo);
  const qs = params.toString();
  const res = await safeFetch("/api/audit" + (qs ? "?" + qs : ""));
  if (generation !== auditFetchGeneration) return;
  auditLoaded = true;
  if (!res.ok) {
    auditError = res.error || true;
    auditRows = [];
    renderAudit();
    return;
  }
  auditError = null;
  auditRows = res.data.audit || [];
  renderAudit();
}

function bindAuditFilters() {
  const actionEl = $("audit-action");
  const targetEl = $("audit-target");
  const fromEl = $("audit-from");
  const toEl = $("audit-to");
  const clearEl = $("audit-clear");
  if (!actionEl || actionEl.dataset.bound) return;
  actionEl.dataset.bound = "1";
  actionEl.addEventListener("change", () => {
    auditAction = actionEl.value.trim();
    loadAudit();
  });
  actionEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    auditAction = actionEl.value.trim();
    loadAudit();
  });
  targetEl.addEventListener("change", () => {
    auditTargetType = targetEl.value;
    loadAudit();
  });
  fromEl.addEventListener("change", () => {
    auditFrom = fromEl.value;
    loadAudit();
  });
  toEl.addEventListener("change", () => {
    auditTo = toEl.value;
    loadAudit();
  });
  clearEl.addEventListener("click", () => {
    auditAction = "";
    auditTargetType = "";
    auditFrom = "";
    auditTo = "";
    actionEl.value = "";
    targetEl.value = "";
    fromEl.value = "";
    toEl.value = "";
    loadAudit();
  });
}

bindAuditFilters();
