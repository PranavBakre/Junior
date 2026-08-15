/* =================== copy / resume =================== */
function resumeCmd(provider, sessionId, resumeCwd) {
  if (!sessionId) return null;
  const r = provider === "claude"
    ? "claude --resume " + sessionId
    : provider === "codex" || provider === "codex-app-server"
      ? "codex resume " + sessionId
      : "opencode --session " + sessionId;
  return resumeCwd ? "cd " + resumeCwd + " && " + r : r;
}
function cmdRow(cmd) {
  if (!cmd) return '<div class="faint" style="margin-top:8px">no session id</div>';
  return (
    '<div class="cmd-row"><code title="' + esc(cmd) + '">' + esc(cmd) + "</code>" +
    '<button class="copy-btn" type="button" data-cmd="' + esc(cmd) + '">copy</button></div>'
  );
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  await copyText(btn.dataset.cmd || "");
  btn.textContent = "copied";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("copied"); }, 1500);
});

/* =================== threads =================== */
function renderThreadChips() {
  const counts = { all: sessions.length, busy: 0, idle: 0, draining: 0, error: 0 };
  for (const s of sessions) {
    if (s.status === "busy") counts.busy++;
    else if (s.status === "draining") counts.draining++;
    else if (s.status === "idle") counts.idle++;
    if (isErrorSession(s)) counts.error++;
  }
  const keys = ["all", "busy", "idle", "draining", "error"];
  $("th-chips").innerHTML = keys.map((k) =>
    '<span class="chip' + (thFilter === k ? " on" : "") + '" data-f="' + k + '">' +
    k + " · " + counts[k] + "</span>"
  ).join("");
}

function renderThreads() {
  renderThreadChips();
  const rows = sessions.filter((t) => {
    if (thFilter === "error") {
      if (!isErrorSession(t)) return false;
    } else if (thFilter !== "all" && t.status !== thFilter) {
      return false;
    }
    if (thQuery) {
      const hay = ((t.channel || "") + " " + t.threadId + " " + (t.targetRepo || "")).toLowerCase();
      if (!hay.includes(thQuery)) return false;
    }
    return true;
  });
  if (rows.length === 0) {
    $("th-list").innerHTML = '<div class="empty">' +
      (sessions.length === 0 ? "No active threads." : "No threads match.") + "</div>";
    return;
  }
  $("th-list").innerHTML = rows.map((t) => {
    const agents = (t.agents || []).map((a) =>
      '<span class="apill ' + esc(a.status) + '">' + esc(a.agentName) + " · " + esc(a.status) + "</span>"
    ).join("") || '<span class="faint" style="font-size:11.5px">no agents</span>';
    const err = t.lastError
      ? '<div class="err-inline">✕ ' + esc(t.lastError.type) + ": " + esc(t.lastError.message) + "</div>"
      : "";
    const stuck = t.status === "busy" && t.lastActivity && Date.now() - t.lastActivity > STUCK_MS
      ? ' <span class="apill busy">silent ' + ago(t.lastActivity) + "</span>"
      : "";
    const pend = pendingCount(t.pendingMessages);
    return (
      '<div class="th-row" data-open-thread="' + esc(t.threadId) + '">' +
      '<div><div class="chan">' + esc(t.channel || "—") +
      (t.muted ? ' <span class="apill">muted</span>' : "") +
      (t.dormant ? ' <span class="apill">dormant</span>' : "") + "</div>" +
      '<div class="tid">' + esc(t.threadId) + "</div>" +
      '<div class="meta">' + esc(t.targetRepo || "no repo") +
      (t.baseRef ? " · " + esc(t.baseRef) : "") +
      (t.agentType ? " · " + esc(t.agentType) : "") + "</div>" + err + "</div>" +
      "<div>" + pill(t.status) + stuck +
      (pend ? '<div class="meta" style="margin-top:4px">' + pend + " buffered</div>" : "") + "</div>" +
      '<div class="agents-cell">' + agents + "</div>" +
      '<div class="last">' + ago(t.lastActivity) + " ago</div></div>"
    );
  }).join("");
}

$("th-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  thFilter = chip.dataset.f;
  renderThreads();
});
$("th-search").addEventListener("input", (e) => {
  thQuery = e.target.value.toLowerCase();
  renderThreads();
});
$("th-list").addEventListener("click", (e) => {
  const row = e.target.closest("[data-open-thread]");
  if (row) openDrawer(row.dataset.openThread);
});

async function openDrawer(threadId, settle) {
  drawerThreadId = threadId;
  $("drawer").innerHTML = '<button class="close" type="button" id="drawer-close">esc</button><div class="empty">loading…</div>';
  $("drawer").classList.add("open");
  $("drawer-scrim").classList.add("open");
  $("drawer-close").addEventListener("click", closeDrawer);

  const res = await safeFetch("/api/sessions/" + encodeURIComponent(threadId));
  if (drawerThreadId !== threadId) return;
  if (!res.ok || !res.data || !res.data.session) {
    $("drawer").innerHTML =
      '<button class="close" type="button" id="drawer-close">esc</button>' +
      '<div class="empty">Failed to load session detail.</div>';
    $("drawer-close").addEventListener("click", closeDrawer);
    return;
  }
  const t = res.data.session;
  const provider = t.provider || "opencode";
  const cwd = t.resumeCwd || null;
  const leadId = t.leadSessionId || t.sessionId;
  const agents = Array.isArray(t.agents) ? t.agents : [];
  const pend = pendingCount(t.pendingMessages);
  const slackAction = (t.slackPermalink || res.data.slackPermalink)
    ? '<a class="slack-action" href="' + esc(t.slackPermalink || res.data.slackPermalink) +
      '" target="_blank" rel="noopener noreferrer">Open thread in Slack <span aria-hidden="true">↗</span></a>'
    : "";

  const agentHtml = agents.length
    ? agents.map((a) => {
        const ap = a.provider || provider;
        const acwd = cwd;
        return (
          '<div class="agent-card"><div class="top"><b>' + esc(a.agentName) + "</b>" + pill(a.status) +
          '<span class="apill" style="margin-left:auto">' + esc(ap) + "</span></div>" +
          '<div class="meta">sid <code>' + esc(a.sessionId || "—") + "</code><br/>last activity " +
          ago(a.lastActivity) + " ago" +
          (pendingCount(a.pendingMessages) ? " · " + pendingCount(a.pendingMessages) + " buffered" : "") +
          "</div>" +
          cmdRow(resumeCmd(ap, a.sessionId, acwd)) + "</div>"
        );
      }).join("")
    : '<div class="faint">no agent sessions yet</div>';

  $("drawer").innerHTML =
    '<button class="close" type="button" id="drawer-close">esc</button>' +
    "<h3>" + esc(t.channel || "thread") + "</h3>" +
    '<div class="mono" style="font-size:11px;color:var(--accent)">' + esc(t.threadId) + "</div>" +
    slackAction +
    '<div style="margin-top:10px">' + pill(t.status) +
    (pend ? ' <span class="apill">' + pend + " buffered</span>" : "") +
    (t.muted ? ' <span class="apill">muted</span>' : "") +
    (t.dormant ? ' <span class="apill">dormant</span>' : "") + "</div>" +
    (t.lastError
      ? '<div class="err-inline" style="margin-top:10px">✕ ' + esc(t.lastError.type) + ": " +
        esc(t.lastError.message) + "</div>"
      : "") +
    '<div class="kv">' +
    '<span class="k">lead session</span><code>' + esc(leadId || "—") + "</code>" +
    '<span class="k">provider</span><span>' + esc(provider) + "</span>" +
    '<span class="k">agent type</span><span>' + esc(t.agentType || "—") + "</span>" +
    '<span class="k">target repo</span><span>' + esc(t.targetRepo || "—") +
    (t.baseRef ? " @ " + esc(t.baseRef) : "") + "</span>" +
    '<span class="k">worktree</span><span>' + (t.hasWorktree ? "yes" : "no") + "</span>" +
    '<span class="k">resume cwd</span><span class="mono" style="font-size:11px">' +
    esc(t.resumeCwd || "—") + "</span>" +
    '<span class="k">last activity</span><span>' + ago(t.lastActivity) + " ago</span>" +
    '<span class="k">driver</span><span>' + esc(t.driverMode || "—") + "</span>" +
    '<span class="k">spend</span><span>' + esc(formatSpendSummary(t.spend)) + "</span>" +
    "</div>" +
    '<h3 class="sect">Resume lead session (' + esc(provider) + ")</h3>" +
    cmdRow(resumeCmd(provider, leadId, cwd)) +
    '<h3 class="sect">Agent sessions · ' + agents.length + "</h3>" + agentHtml +
    continueComposerHtml(t, agents);

  $("drawer-close").addEventListener("click", closeDrawer);
  bindContinueComposer(t);
  if (settle && settle.text) setContinueStatus(settle.text, !!settle.isError);
}

function continueComposerHtml(t, agents) {
  if (!t.channel || !t.threadId) return "";
  const options = ['<option value="">thread default</option>'];
  if (t.defaultAgent === "lead") {
    options[0] = '<option value="lead">lead</option>';
    options.push('<option value="default">default</option>');
  } else {
    options.push('<option value="lead">lead</option>');
  }
  for (const a of agents) {
    if (a.agentName === "lead" || a.agentName === "default" || a.agentName === "junior") continue;
    options.push('<option value="' + esc(a.agentName) + '">' + esc(a.agentName) + "</option>");
  }
  const mutedNote = t.muted
    ? '<div class="continue-status">Session is muted. Unmute in Slack before continuing.</div>'
    : "";
  return (
    '<div class="continue-box">' +
    '<h3 class="sect">Continue</h3>' +
    '<textarea id="continue-prompt" maxlength="8000" placeholder="Send a prompt into this thread" ' +
    (t.muted ? "disabled " : "") + "></textarea>" +
    '<div class="continue-actions">' +
    '<select class="ctrl" id="continue-agent"' + (t.muted ? " disabled" : "") + ">" +
    options.join("") + "</select>" +
    '<button class="ctrl" type="button" id="continue-btn"' + (t.muted ? " disabled" : "") +
    ">Continue</button>" +
    '<button class="ctrl danger" type="button" id="stop-btn">Stop</button>' +
    "</div>" +
    mutedNote +
    '<div class="continue-status" id="continue-status"></div>' +
    "</div>"
  );
}

function setContinueStatus(text, isError) {
  const el = $("continue-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isError);
}

async function postSessionWrite(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body == null ? "{}" : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

function bindContinueComposer(t) {
  const promptEl = $("continue-prompt");
  const agentEl = $("continue-agent");
  const continueBtn = $("continue-btn");
  const stopBtn = $("stop-btn");
  if (continueBtn) {
    continueBtn.addEventListener("click", async () => {
      const prompt = promptEl ? promptEl.value : "";
      if (!prompt.trim()) {
        setContinueStatus("Enter a prompt.", true);
        return;
      }
      continueBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      setContinueStatus("Sending…", false);
      let settled = false;
      try {
        const agentName = agentEl && agentEl.value ? agentEl.value : undefined;
        const res = await postSessionWrite(
          "/api/sessions/" + encodeURIComponent(t.threadId) + "/continue",
          { prompt, agentName },
        );
        if (!res.ok) {
          setContinueStatus((res.data && res.data.error) || ("Continue failed (" + res.status + ")"), true);
          return;
        }
        settled = true;
        const statusText = res.data && res.data.status === "buffered" ? "Buffered." : "Accepted.";
        if (promptEl) promptEl.value = "";
        if (typeof refreshMain === "function") await refreshMain();
        if (drawerThreadId === t.threadId) await openDrawer(t.threadId, { text: statusText });
      } catch (err) {
        setContinueStatus((err && err.message) || "Continue failed.", true);
      } finally {
        if (!settled) {
          continueBtn.disabled = false;
          if (stopBtn) stopBtn.disabled = false;
        }
      }
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      stopBtn.disabled = true;
      if (continueBtn) continueBtn.disabled = true;
      setContinueStatus("Stopping…", false);
      let settled = false;
      try {
        const res = await postSessionWrite(
          "/api/sessions/" + encodeURIComponent(t.threadId) + "/stop",
        );
        if (!res.ok) {
          setContinueStatus((res.data && res.data.error) || ("Stop failed (" + res.status + ")"), true);
          return;
        }
        settled = true;
        const statusText = (res.data && res.data.message) || "Stopped.";
        if (typeof refreshMain === "function") await refreshMain();
        if (drawerThreadId === t.threadId) await openDrawer(t.threadId, { text: statusText });
      } catch (err) {
        setContinueStatus((err && err.message) || "Stop failed.", true);
      } finally {
        if (!settled) {
          stopBtn.disabled = false;
          if (continueBtn && !t.muted) continueBtn.disabled = false;
        }
      }
    });
  }
}

function closeDrawer() {
  drawerThreadId = null;
  $("drawer").classList.remove("open");
  $("drawer-scrim").classList.remove("open");
}
$("drawer-scrim").addEventListener("click", closeDrawer);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
