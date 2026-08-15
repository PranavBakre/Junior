/* =================== workflows =================== */
var WF_INSTR_MAX = 500;
var wfActionBusy = false;

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
    const concurrency = w.concurrency || "skip";
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
    const runner = w.nativeHandler
      ? ("native/" + w.nativeHandler)
      : w.runner
        ? (w.runner.provider + "/" + w.runner.agentName)
        : "none";
    const runLabel = "run · " + concurrency;
    const instructions = w.nativeHandler
      ? ""
      : '<textarea class="wf-instr" data-name="' + esc(w.name) +
        '" maxlength="' + WF_INSTR_MAX + '" placeholder="optional instructions"></textarea>' +
        '<div class="row"><span class="wf-count" data-count="' + esc(w.name) + '">0 / ' +
        WF_INSTR_MAX + "</span></div>";
    return (
      '<div class="wf-card' + (selectedWorkflowName === w.name ? " on" : "") +
      '" id="wf-card-' + esc(w.name) + '" data-name="' + esc(w.name) +
      '" data-workflow="' + esc(w.name) + '">' +
      '<div><div class="name">' + esc(w.name) + "</div>" +
      '<div class="desc">' + esc(w.description || "no description") + "</div>" +
      '<div class="src">' + esc(w.sourcePath || "") + "</div></div>" +
      '<div class="mrow">status ' + pill(displayStatus) +
      "<br/>scheduler <b>" + esc(schedulerStatus) + "</b>" +
      "<br/>next <b>" + esc(fmtNext(state.nextRunAt)) + "</b>" +
      "<br/>last <b>" + (state.lastRunAt ? ago(state.lastRunAt) + " ago" : "never") + "</b>" +
      "<br/>runner <b>" + esc(runner) + "</b>" +
      "<br/>concurrency <b>" + esc(concurrency) + "</b>" +
      "<br/>cron <b>" + esc(triggers) + "</b>" +
      (state.lastError ? '<br/><span style="color:var(--red)">' + esc(state.lastError) + "</span>" : "") +
      "</div>" +
      '<div><div class="mrow" style="margin-bottom:2px">recent runs · oldest → newest</div>' +
      '<div class="runs">' + dots + "</div>" + lastRuns + "</div>" +
      '<div class="wf-actions">' +
      instructions +
      '<div class="row">' +
      '<button class="ctrl wf-run" type="button" data-name="' + esc(w.name) + '"' +
      (w.enabled ? "" : " disabled") + ">" + esc(runLabel) + "</button>" +
      (schedulerStatus === "stopped"
        ? '<button class="ctrl wf-start" type="button" data-name="' + esc(w.name) + '"' +
          (w.enabled ? "" : " disabled") + ">start</button>"
        : '<button class="ctrl wf-stop" type="button" data-name="' + esc(w.name) + '">stop</button>') +
      "</div></div></div>"
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

function setWfStatus(text, kind) {
  const el = $("wf-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = kind || "";
}

async function postWorkflow(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body == null ? "{}" : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function refreshWorkflowList() {
  const w = await safeFetch("/api/workflows");
  if (w.ok) {
    workflows = w.data.workflows || [];
    workflowErrors = w.data.errors || [];
    renderWorkflows();
  }
}

async function runWorkflow(name) {
  if (wfActionBusy) return;
  const item = workflows.find((w) => w.name === name);
  if (!item) return;
  const running = item.displayStatus === "running";
  if (item.concurrency === "skip" && running) {
    if (!confirm("This workflow is already running (concurrency=skip). A second run will be skipped. Continue?")) {
      return;
    }
  }
  if (item.concurrency === "parallel" && running) {
    if (!confirm("This workflow allows parallel runs; start another?")) return;
  }
  const field = document.querySelector('.wf-instr[data-name="' + name + '"]');
  const instructions = field ? String(field.value || "").trim() : "";
  wfActionBusy = true;
  setWfStatus("starting " + name + "…");
  try {
    const result = await postWorkflow("/api/workflows/" + encodeURIComponent(name) + "/run", {
      instructions: instructions || undefined,
    });
    if (!result.ok && result.status !== 202) {
      setWfStatus(result.data.error || ("run failed " + result.status), "err");
      return;
    }
    const summary = result.data.summary || result.data.status || "started";
    setWfStatus(summary, result.data.status === "skipped" ? "" : "ok");
    await refreshWorkflowList();
  } catch (err) {
    setWfStatus(String(err && err.message ? err.message : err), "err");
  } finally {
    wfActionBusy = false;
  }
}

async function toggleWorkflow(name, action) {
  if (wfActionBusy) return;
  wfActionBusy = true;
  setWfStatus(action + " " + name + "…");
  try {
    const result = await postWorkflow(
      "/api/workflows/" + encodeURIComponent(name) + "/" + action,
    );
    if (!result.ok) {
      setWfStatus(result.data.error || (action + " failed " + result.status), "err");
      return;
    }
    setWfStatus(name + " " + (result.data.status || action), "ok");
    await refreshWorkflowList();
  } catch (err) {
    setWfStatus(String(err && err.message ? err.message : err), "err");
  } finally {
    wfActionBusy = false;
  }
}

async function reloadWorkflows() {
  if (wfActionBusy) return;
  wfActionBusy = true;
  setWfStatus("reloading…");
  try {
    const result = await postWorkflow("/api/workflows/reload");
    if (!result.ok) {
      setWfStatus(result.data.error || ("reload failed " + result.status), "err");
      return;
    }
    setWfStatus("reloaded " + (result.data.definitions ?? 0) + " workflow(s)", "ok");
    await refreshWorkflowList();
  } catch (err) {
    setWfStatus(String(err && err.message ? err.message : err), "err");
  } finally {
    wfActionBusy = false;
  }
}

document.addEventListener("click", (event) => {
  const run = event.target.closest && event.target.closest(".wf-run");
  if (run) {
    event.preventDefault();
    runWorkflow(run.dataset.name);
    return;
  }
  const start = event.target.closest && event.target.closest(".wf-start");
  if (start) {
    event.preventDefault();
    toggleWorkflow(start.dataset.name, "start");
    return;
  }
  const stop = event.target.closest && event.target.closest(".wf-stop");
  if (stop) {
    event.preventDefault();
    toggleWorkflow(stop.dataset.name, "stop");
    return;
  }
  if (event.target.id === "wf-reload") {
    event.preventDefault();
    reloadWorkflows();
  }
});

document.addEventListener("input", (event) => {
  const field = event.target.closest && event.target.closest(".wf-instr");
  if (!field) return;
  const name = field.dataset.name;
  const counter = document.querySelector('.wf-count[data-count="' + name + '"]');
  if (counter) counter.textContent = field.value.length + " / " + WF_INSTR_MAX;
});
