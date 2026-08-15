/* =================== workflows =================== */
function renderWorkflows() {
  const items = workflows;
  const errors = workflowErrors || [];
  if (!items.length && !errors.length) {
    $("wf-list").innerHTML = '<div class="empty">No workflows loaded.</div>';
    return;
  }
  let html = items.map((w) => {
    const state = w.state || {};
    const schedulerStatus = state.status || (w.enabled ? "active" : "stopped");
    const displayStatus = w.displayStatus ?? schedulerStatus;
    // runs are newest-first from API; reverse for oldest → newest dots
    const runs = (w.runs || []).slice().reverse();
    const dots = runs.map((r) =>
      '<span class="run-dot ' + esc(r.status) + '" title="' + esc(r.status) + '"></span>'
    ).join("") || '<span class="faint" style="font-size:11px">no runs</span>';
    const lastRuns = (w.runs || []).slice(0, 5).map((r) => {
      const dur = r.finishedAt && r.startedAt
        ? " · " + fmtRemaining(r.finishedAt - r.startedAt)
        : "";
      return (
        '<div class="run-line">' + pill(r.status) + " " +
        esc(new Date(r.startedAt).toLocaleString()) + " · " + esc(r.reason || "") +
        dur +
        (r.error ? ' <span style="color:var(--red)">' + esc(r.error) + "</span>" : "") +
        "</div>"
      );
    }).join("") || '<div class="faint run-line">no runs yet</div>';
    const triggers = (w.triggers || []).map((t) =>
      t.type === "schedule" ? (t.cron + " " + (t.timezone || "")) : t.type
    ).join(", ") || "none";
    const runner = w.runner
      ? (w.runner.provider + "/" + w.runner.agentName)
      : "none";
    return (
      '<div class="wf-card' + (selectedWorkflowName === w.name ? " on" : "") +
      '" id="wf-card-' + esc(w.name) + '" data-workflow="' + esc(w.name) + '">' +
      '<div><div class="name">' + esc(w.name) + "</div>" +
      '<div class="desc">' + esc(w.description || "no description") + "</div>" +
      '<div class="src">' + esc(w.sourcePath || "") + "</div></div>" +
      '<div class="mrow">status ' + pill(displayStatus) +
      "<br/>scheduler <b>" + esc(schedulerStatus) + "</b>" +
      "<br/>next <b>" + esc(fmtNext(state.nextRunAt)) + "</b>" +
      "<br/>last <b>" + (state.lastRunAt ? ago(state.lastRunAt) + " ago" : "never") + "</b>" +
      "<br/>runner <b>" + esc(runner) + "</b>" +
      "<br/>cron <b>" + esc(triggers) + "</b>" +
      (state.lastError ? '<br/><span style="color:var(--red)">' + esc(state.lastError) + "</span>" : "") +
      "</div>" +
      '<div><div class="mrow" style="margin-bottom:2px">recent runs · oldest → newest</div>' +
      '<div class="runs">' + dots + "</div>" + lastRuns + "</div></div>"
    );
  }).join("");
  if (errors.length) {
    html += '<div class="empty" style="color:var(--red)">Validation errors: ' +
      errors.map((e) => esc(e.path) + " — " + esc(e.message)).join("; ") + "</div>";
  }
  $("wf-list").innerHTML = html;
  if (workflowScrollPending && selectedWorkflowName) {
    workflowScrollPending = false;
    const card = document.getElementById("wf-card-" + selectedWorkflowName);
    if (card) card.scrollIntoView({ block: "center" });
  }
}
