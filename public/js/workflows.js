/* =================== workflows =================== */
var WF_INSTR_MAX = 500;
var wfActionBusy = false;
var wfEditor = {
  mode: null,
  name: null,
  sourceRoot: null,
  fileVersionHash: null,
  git: null,
  parentGit: null,
};

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
      '<button class="ctrl wf-edit" type="button" data-name="' + esc(w.name) + '">edit</button>' +
      "</div></div></div>"
    );
  }).join("");
  if (errors.length) {
    html += '<div class="empty" style="color:var(--red)">Validation errors: ' +
      errors.map((e) => esc(e.path) + " — " + esc(e.message)).join("; ") + "</div>";
  }
  const draft = snapshotWorkflowInputs();
  $("wf-list").innerHTML = html;
  restoreWorkflowInputs(draft);
  if (workflowScrollPending && selectedWorkflowName) {
    workflowScrollPending = false;
    const card = document.getElementById("wf-card-" + selectedWorkflowName);
    if (card) card.scrollIntoView({ block: "center" });
  }
}

function snapshotWorkflowInputs() {
  const values = {};
  let focus = null;
  const list = $("wf-list");
  if (!list) return { values, focus };
  for (const field of list.querySelectorAll(".wf-instr")) {
    values[field.dataset.name] = field.value;
  }
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("wf-instr")) {
    focus = {
      name: active.dataset.name,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }
  return { values, focus };
}

function restoreWorkflowInputs(draft) {
  const list = $("wf-list");
  if (!list) return;
  for (const name of Object.keys(draft.values || {})) {
    const field = list.querySelector('.wf-instr[data-name="' + name + '"]');
    if (!field) continue;
    field.value = draft.values[name];
    const counter = list.querySelector('.wf-count[data-count="' + name + '"]');
    if (counter) counter.textContent = field.value.length + " / " + WF_INSTR_MAX;
  }
  if (!draft.focus) return;
  const field = list.querySelector('.wf-instr[data-name="' + draft.focus.name + '"]');
  if (!field) return;
  field.focus();
  try {
    field.setSelectionRange(draft.focus.start, draft.focus.end);
  } catch {
    // some browsers reject setSelectionRange on an unfocused node
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
    workflowWriteGit = w.data.git || workflowWriteGit;
    overlayRootExists = Boolean(w.data.overlayRootExists);
    renderWorkflows();
    if (wfEditor.mode === "create") syncCreateGitControls();
  }
}

async function runWorkflow(name) {
  if (wfActionBusy) return;
  const item = workflows.find((w) => w.name === name);
  if (!item) return;
  wfActionBusy = true;
  try {
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
    setWfStatus("starting " + name + "…");
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
    return;
  }
  const edit = event.target.closest && event.target.closest(".wf-edit");
  if (edit) {
    event.preventDefault();
    openWorkflowEditor(edit.dataset.name);
    return;
  }
  if (event.target.id === "wf-new") {
    event.preventDefault();
    openNewWorkflowEditor();
    return;
  }
  if (event.target.id === "wf-editor-close") {
    event.preventDefault();
    closeWorkflowEditor();
    return;
  }
  if (event.target.id === "wf-validate") {
    event.preventDefault();
    validateWorkflowEditor();
    return;
  }
  if (event.target.id === "wf-save") {
    event.preventDefault();
    saveWorkflowEditor();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "wf-source-root" || event.target.id === "wf-anyway") {
    syncCreateGitControls();
  }
});

document.addEventListener("input", (event) => {
  const field = event.target.closest && event.target.closest(".wf-instr");
  if (!field) return;
  const name = field.dataset.name;
  const counter = document.querySelector('.wf-count[data-count="' + name + '"]');
  if (counter) counter.textContent = field.value.length + " / " + WF_INSTR_MAX;
});

function newWorkflowTemplate(name) {
  const slug = name || "my-workflow";
  return [
    "---",
    "name: " + slug,
    "enabled: true",
    "description: ",
    "ownerSlackUserIds: []",
    "triggers:",
    "  - type: command",
    "    command: " + slug,
    "outputs:",
    "  - type: docs",
    "    path: data/workflow-runs/" + slug,
    "permissions:",
    "  tools:",
    "    - docs.write",
    "---",
    "",
    "Describe the work.",
    "",
  ].join("\n");
}

function gitBlocked(git) {
  return Boolean(git && (git.detached || git.merging || git.rebasing));
}

function gitNeedsAnyway(git) {
  return Boolean(git && git.branch && git.branch !== "main" && git.branch !== "master");
}

function writeReposForEditor() {
  const sourceRoot = $("wf-source-root").value;
  const repos = [];
  if (wfEditor.mode === "edit") {
    repos.push({ label: wfEditor.sourceRoot === "overlay" ? "agents-org" : "junior", git: wfEditor.git });
    if (wfEditor.sourceRoot === "overlay") {
      repos.push({ label: "junior", git: wfEditor.parentGit || (workflowWriteGit && workflowWriteGit.junior) });
    }
    return repos;
  }
  if (sourceRoot === "overlay") {
    repos.push({ label: "agents-org", git: workflowWriteGit && workflowWriteGit.overlay });
    repos.push({ label: "junior", git: workflowWriteGit && workflowWriteGit.junior });
  } else {
    repos.push({ label: "junior", git: workflowWriteGit && workflowWriteGit.junior });
  }
  return repos;
}

function renderEditorBanners(extra) {
  const el = $("wf-banners");
  if (!el) return;
  const banners = extra ? extra.slice() : [];
  if (wfEditor.mode === "edit" && wfEditor.sourceRoot === "public" && wfEditor.overlayExists) {
    banners.push("An overlay is active; editing the public file will not change runtime.");
  } else if (wfEditor.mode === "edit" && wfEditor.sourceRoot === "overlay") {
    banners.push("An overlay is active; runtime loads this overlay file.");
  }
  if (wfEditor.runtimeUsesFile === false) {
    banners.push(
      "Runtime is using last-known-good (`" +
      esc(wfEditor.loadedVersionHash || "") +
      "`); editor shows on-disk bytes (`" +
      esc(wfEditor.fileVersionHash || "") +
      "`).",
    );
  }
  el.innerHTML = banners.map((text) =>
    '<div class="wf-banner' + (text.indexOf("parent pointer") >= 0 ? " err" : "") + '">' + text + "</div>"
  ).join("");
}

function syncCreateGitControls() {
  const repos = writeReposForEditor();
  const blocked = repos.some((item) => gitBlocked(item.git));
  const anywayNeeded = repos.some((item) => gitNeedsAnyway(item.git));
  const row = $("wf-anyway-row");
  const branch = $("wf-branch");
  if (row) row.style.display = anywayNeeded && !blocked ? "flex" : "none";
  if (branch) {
    branch.textContent = repos
      .filter((item) => gitNeedsAnyway(item.git))
      .map((item) => item.label + ":" + item.git.branch)
      .join(", ") || "branch";
  }
  const save = $("wf-save");
  if (save) {
    save.disabled = blocked || (anywayNeeded && !$("wf-anyway").checked);
  }
}

function closeWorkflowEditor() {
  wfEditor = {
    mode: null,
    name: null,
    sourceRoot: null,
    fileVersionHash: null,
    git: null,
    parentGit: null,
  };
  const editor = $("wf-editor");
  if (editor) editor.classList.remove("open");
  if ($("wf-save-result")) $("wf-save-result").textContent = "";
}

function openNewWorkflowEditor() {
  wfEditor = {
    mode: "create",
    name: null,
    sourceRoot: overlayRootExists ? "overlay" : "public",
    fileVersionHash: null,
    git: null,
    parentGit: null,
    runtimeUsesFile: true,
  };
  $("wf-editor-title").textContent = "New workflow";
  $("wf-name").value = "";
  $("wf-name").disabled = false;
  $("wf-source-root").value = overlayRootExists ? "overlay" : "public";
  $("wf-source-root").disabled = false;
  $("wf-markdown").value = newWorkflowTemplate("my-workflow");
  $("wf-anyway").checked = false;
  $("wf-save-result").textContent = "";
  $("wf-editor").classList.add("open");
  renderEditorBanners();
  syncCreateGitControls();
}

async function openWorkflowEditor(name) {
  setWfStatus("loading " + name + "…");
  const res = await safeFetch("/api/workflows/" + encodeURIComponent(name));
  if (!res.ok) {
    setWfStatus((res.data && res.data.error) || "failed to load workflow", "err");
    return;
  }
  const source = res.data.source || {};
  const git = res.data.git || {};
  wfEditor = {
    mode: "edit",
    name: name,
    sourceRoot: source.sourceRoot || "public",
    fileVersionHash: source.fileVersionHash || "",
    loadedVersionHash: source.loadedVersionHash || null,
    overlayExists: Boolean(source.overlayExists || source.sourceRoot === "overlay"),
    runtimeUsesFile: res.data.runtimeUsesFile !== false,
    git: git,
    parentGit: git.parent || null,
  };
  $("wf-editor-title").textContent = "Edit " + name;
  $("wf-name").value = name;
  $("wf-name").disabled = true;
  $("wf-source-root").value = wfEditor.sourceRoot;
  $("wf-source-root").disabled = true;
  $("wf-markdown").value = source.markdown || "";
  $("wf-anyway").checked = false;
  $("wf-save-result").textContent = "";
  $("wf-editor").classList.add("open");
  renderEditorBanners();
  syncCreateGitControls();
  setWfStatus("");
}

async function validateWorkflowEditor() {
  const name = wfEditor.mode === "create" ? String($("wf-name").value || "").trim() : wfEditor.name;
  if (!name) {
    setWfStatus("name is required", "err");
    return;
  }
  const result = await fetch("/api/workflows/" + encodeURIComponent(name) + "?validate=1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: $("wf-markdown").value }),
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    const errors = (data.errors || []).map((e) => e.message).join("; ");
    setWfStatus(errors || data.error || "invalid workflow", "err");
    return;
  }
  setWfStatus("valid", "ok");
}

async function saveWorkflowEditor() {
  if (wfActionBusy) return;
  const name = wfEditor.mode === "create" ? String($("wf-name").value || "").trim() : wfEditor.name;
  if (!name) {
    setWfStatus("name is required", "err");
    return;
  }
  wfActionBusy = true;
  $("wf-save").disabled = true;
  setWfStatus("saving " + name + "…");
  try {
    const payload = {
      markdown: $("wf-markdown").value,
      sourceRoot: $("wf-source-root").value,
      commitHereAnyway: $("wf-anyway").checked,
    };
    if (wfEditor.mode === "create") payload.name = name;
    if (wfEditor.mode === "edit") {
      payload.expectedVersionHash = wfEditor.fileVersionHash;
    }
    const path = wfEditor.mode === "create"
      ? "/api/workflows"
      : "/api/workflows/" + encodeURIComponent(name);
    const result = await fetch(path, {
      method: wfEditor.mode === "create" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await result.json().catch(() => ({}));
    if (!result.ok) {
      const errors = (data.errors || []).map((e) => e.message).join("; ");
      setWfStatus(errors || data.error || ("save failed " + result.status), "err");
      return;
    }
    const lines = [];
    if (data.commit) {
      lines.push(
        data.commit.repo + " " + (data.commit.sha || "").slice(0, 12) +
        " on " + (data.commit.branch || "?") + " · not pushed",
      );
      if (data.commit.stat) lines.push(data.commit.stat);
    }
    if (data.parentPointer && data.parentPointer.sha) {
      lines.push(
        "junior pointer " + data.parentPointer.sha.slice(0, 12) +
        " on " + (data.parentPointer.branch || "?") + " · not pushed",
      );
      if (data.parentPointer.stat) lines.push(data.parentPointer.stat);
    }
    $("wf-save-result").textContent = lines.join("\n");
    const extra = [];
    if (data.parentPointerCommitted === false) {
      extra.push(
        "parent pointer failed after overlay commit " +
        ((data.commit && data.commit.sha) || "") +
        ". Bump agents-org manually. " +
        ((data.parentPointer && data.parentPointer.detail) || data.parentPointer && data.parentPointer.code || ""),
      );
    }
    renderEditorBanners(extra);
    setWfStatus("saved " + name, data.parentPointerCommitted === false ? "err" : "ok");
    if (wfEditor.mode === "edit") wfEditor.fileVersionHash = data.versionHash;
    await refreshWorkflowList();
    if (wfEditor.mode === "edit") await openWorkflowEditor(name);
  } catch (err) {
    setWfStatus(String(err && err.message ? err.message : err), "err");
  } finally {
    wfActionBusy = false;
    syncCreateGitControls();
  }
}
