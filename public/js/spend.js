/* =================== spend =================== */
var SPEND_GROUPS = ["day", "session", "agent", "provider", "workflow", "pipeline"];

function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

function startOfLocalDayMs(date) {
  const d = date ? new Date(date) : new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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

function fmtInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString();
}

function fmtProviderCost(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return null;
  const n = Number(costUsd);
  if (n === 0) return null;
  if (n >= 0.01) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

function spendBucketLink(groupBy, bucket) {
  const key = bucket && bucket.key;
  if (!key || key === "unknown") return null;
  if (groupBy === "session") return { kind: "thread", id: key };
  if (groupBy === "pipeline") return { kind: "pipeline", id: key };
  if (groupBy === "workflow") return { kind: "workflow", id: key };
  return null;
}

function spendBucketLabel(groupBy, bucket) {
  if (!bucket) return "—";
  if (groupBy === "session") {
    const session = sessions.find((row) => row.threadId === bucket.key);
    if (session) return (session.channel || bucket.label || bucket.key) + " · " + shortId(bucket.key);
  }
  return bucket.label || bucket.key || "—";
}

function sortSpendBuckets(buckets) {
  const dir = spendSortDir === "desc" ? -1 : 1;
  const key = spendSortKey;
  return buckets.slice().sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" || typeof bv === "number") {
      return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    }
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}

function renderSpendKpis() {
  const tz = hostTimeZone();
  const sub = $("spend-sub");
  if (sub) sub.textContent = "token ledger · host TZ " + tz;
  const today = spendToday && spendToday.totals;
  const week = spendWeek && spendWeek.totals;
  if (spendError && !today && !week) {
    $("spend-kpis").innerHTML = '<div class="empty">Failed to load spend.</div>';
    return;
  }
  const todayCost = today ? fmtProviderCost(today.costUsd) : null;
  const weekCost = week ? fmtProviderCost(week.costUsd) : null;
  const kpis = [
    [
      "Today",
      today ? fmtTokens(spendTotalTokens(today)) : "—",
      "",
      today
        ? (todayCost ? todayCost + " provider-reported" : "tokens only") +
          " · " + (today.turns || 0) + " turns · " + tz
        : tz,
    ],
    [
      "7 days",
      week ? fmtTokens(spendTotalTokens(week)) : "—",
      "",
      week
        ? (weekCost ? weekCost + " provider-reported" : "tokens only") +
          " · " + (week.turns || 0) + " turns"
        : "rolling host-local window",
    ],
    [
      "Missing usage",
      week ? String(week.missingUsageTurns || 0) : (today ? String(today.missingUsageTurns || 0) : "—"),
      (week && week.missingUsageTurns > 0) || (today && today.missingUsageTurns > 0) ? "err" : "",
      week
        ? (today ? (today.missingUsageTurns || 0) + " today · " : "") + "turns without telemetry"
        : "turns without telemetry",
    ],
  ];
  $("spend-kpis").innerHTML = kpis.map(([lbl, num, cls, hint]) =>
    '<div class="stat"><div class="lbl">' + esc(lbl) + '</div><div class="num ' + esc(cls) + '">' +
    esc(num) + '</div><div class="sub">' + esc(hint) + "</div></div>"
  ).join("");
}

function renderSpendGroups() {
  $("spend-groups").innerHTML = SPEND_GROUPS.map((group) =>
    '<span class="chip' + (spendGroupBy === group ? " on" : "") + '" data-spend-group="' + group + '">' +
    group + "</span>"
  ).join("");
}

function renderSpendTable() {
  if (spendError && !spendTable) {
    $("spend-table").innerHTML = '<div class="empty">Failed to load spend.</div>';
    return;
  }
  const buckets = (spendTable && spendTable.buckets) || [];
  if (!buckets.length) {
    $("spend-table").innerHTML = '<div class="empty">No usage events in this window.</div>';
    return;
  }
  const cols = [
    ["key", spendGroupBy],
    ["turns", "turns"],
    ["inputTokens", "input"],
    ["outputTokens", "output"],
    ["costUsd", "provider $"],
  ];
  const rows = sortSpendBuckets(buckets).map((bucket) => {
    const link = spendBucketLink(spendGroupBy, bucket);
    const label = spendBucketLabel(spendGroupBy, bucket);
    const name = link
      ? '<a href="#" data-spend-link="' + esc(link.kind) + '" data-spend-id="' + esc(link.id) + '">' +
        esc(label) + "</a>"
      : esc(label);
    const cost = fmtProviderCost(bucket.costUsd);
    return (
      "<tr><td>" + name + '</td><td class="num">' + esc(fmtInt(bucket.turns)) +
      '</td><td class="num">' + esc(fmtInt(bucket.inputTokens)) +
      '</td><td class="num">' + esc(fmtInt(bucket.outputTokens)) +
      '</td><td class="num">' + esc(cost || "—") + "</td></tr>"
    );
  }).join("");
  $("spend-table").innerHTML =
    '<table class="data-table"><thead><tr>' +
    cols.map(([key, label]) =>
      '<th data-sort="' + key + '" class="' +
      (spendSortKey === key ? (spendSortDir === "desc" ? "sort-desc" : "sort-asc") : "") +
      '">' + esc(label) + "</th>"
    ).join("") +
    "</tr></thead><tbody>" + rows + "</tbody></table>";
}

function renderSpend() {
  renderSpendKpis();
  renderSpendGroups();
  renderSpendTable();
}

async function loadSpend() {
  const weekStart = startOfLocalDayMs() - 6 * 24 * 60 * 60 * 1000;
  const tablePath = "/api/spend?from=" + weekStart + "&groupBy=" + encodeURIComponent(spendGroupBy);
  const [todayRes, weekRes] = await Promise.all([
    safeFetch("/api/spend"),
    safeFetch(tablePath),
  ]);
  if (todayRes.ok) spendToday = todayRes.data;
  if (weekRes.ok) {
    spendWeek = weekRes.data;
    spendTable = weekRes.data;
    spendError = null;
  } else if (!todayRes.ok) {
    spendError = weekRes.error || todayRes.error || true;
  } else {
    spendError = weekRes.error || true;
  }
  renderSpend();
}

$("spend-groups").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-spend-group]");
  if (!chip) return;
  spendGroupBy = chip.dataset.spendGroup;
  spendSortKey = "key";
  spendSortDir = "asc";
  loadSpend();
});

$("spend-table").addEventListener("click", (event) => {
  const th = event.target.closest("th[data-sort]");
  if (th) {
    const next = th.dataset.sort;
    if (spendSortKey === next) spendSortDir = spendSortDir === "asc" ? "desc" : "asc";
    else {
      spendSortKey = next;
      spendSortDir = next === "key" ? "asc" : "desc";
    }
    renderSpendTable();
    return;
  }
  const link = event.target.closest("[data-spend-link]");
  if (!link) return;
  event.preventDefault();
  const id = link.dataset.spendId;
  if (link.dataset.spendLink === "thread") {
    location.hash = "threads";
    if (typeof openDrawer === "function") openDrawer(id);
  } else if (link.dataset.spendLink === "pipeline") {
    selectedPipelineId = id;
    location.hash = "pipelines";
  } else if (link.dataset.spendLink === "workflow") {
    location.hash = "workflows";
  }
});
