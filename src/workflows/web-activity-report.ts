import { log } from "../logger.ts";
import {
  newRelicNrqlCommand,
  runReadOnlyCommand,
} from "../observability/read-only-cli.ts";

const TAG = "web-activity-report";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nowIST(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function yesterdayIST(): string {
  const ist = nowIST();
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

function prettyDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function n(v: number | undefined | null): string {
  return (v ?? 0).toLocaleString("en-IN");
}

function pct(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Mixpanel
// ---------------------------------------------------------------------------

const MIXPANEL_EVENTS = [
  "community.post.created",
  "community.comment.created",
  "community.reaction.toggled",
  "community.post.bookmark_toggled",
  "community.post.opened",
  "community.search.query_submitted",
  "community.search.result_clicked",
  "community.notification_pref.changed",
  "community.member_connect.mark_solved.submitted",
  "community.notification.clicked",
] as const;

interface MixpanelData {
  totalEvents: number;
  counts: Record<string, number>;
}

async function fetchMixpanel(yesterday: string): Promise<MixpanelData> {
  const secret = process.env.MIXPANEL_WEB_API_SECRET;
  if (!secret) throw new Error("MIXPANEL_WEB_API_SECRET not set");

  const params = new URLSearchParams({
    from_date: yesterday,
    to_date: yesterday,
    event: JSON.stringify([...MIXPANEL_EVENTS]),
  });

  const resp = await fetch(
    `https://mixpanel.com/api/2.0/events?${params.toString()}`,
    {
      headers: {
        Authorization: `Basic ${btoa(`${secret}:`)}`,
        Accept: "application/json",
      },
    },
  );

  if (!resp.ok) {
    throw new Error(`Mixpanel API ${resp.status}: ${await resp.text()}`);
  }

  const body = (await resp.json()) as {
    data: { values: Record<string, Record<string, number>> };
  };

  const counts: Record<string, number> = {};
  let totalEvents = 0;

  for (const [event, dateValues] of Object.entries(body.data.values)) {
    const count = Object.values(dateValues).reduce((s, v) => s + v, 0);
    counts[event] = count;
    totalEvents += count;
  }

  return { totalEvents, counts };
}

// ---------------------------------------------------------------------------
// New Relic
// ---------------------------------------------------------------------------

interface NewRelicData {
  throughput: number;
  avgResponse: number;
  apdex: number;
  errorCount: number;
  errorRate: number;
  topErrors: Array<{ message: string; count: number }>;
}

async function nrql(query: string, accountId?: number): Promise<Record<string, unknown>[]> {
  const command = newRelicNrqlCommand({ query, accountId });
  const result = await runReadOnlyCommand(command);
  if (result.exitCode !== 0) {
    throw new Error(`newrelic CLI exit ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>[];
  } catch {
    throw new Error(`newrelic CLI returned non-JSON: ${result.stdout.slice(0, 200)}`);
  }
}

async function fetchNewRelic(): Promise<NewRelicData> {
  const rawAccountId = process.env.NEW_RELIC_ACCOUNT_ID;
  const accountId = rawAccountId ? parseInt(rawAccountId, 10) : undefined;

  const [throughputRows, avgRows, apdexRows, errorCountRows, errorRateRows, topErrorRows] =
    await Promise.all([
      nrql("SELECT count(*) FROM Transaction SINCE 1 day ago UNTIL today", accountId),
      nrql("SELECT average(duration) FROM Transaction SINCE 1 day ago UNTIL today", accountId),
      nrql("SELECT apdex(duration, 0.5) FROM Transaction SINCE 1 day ago UNTIL today", accountId),
      nrql("SELECT count(*) FROM TransactionError SINCE 1 day ago UNTIL today", accountId),
      nrql("SELECT percentage(count(*), WHERE error IS true) FROM Transaction SINCE 1 day ago UNTIL today", accountId),
      nrql("SELECT count(*) FROM TransactionError FACET error.message SINCE 1 day ago UNTIL today LIMIT 5", accountId),
    ]);

  const throughput = (throughputRows[0]?.["count"] as number) ?? 0;
  const avgResponse = (avgRows[0]?.["average.duration"] as number) ?? 0;
  const apdex = (apdexRows[0]?.["score"] as number) ?? 0;
  const errorCount = (errorCountRows[0]?.["count"] as number) ?? 0;
  const errorRate = (errorRateRows[0]?.["result"] as number) ?? 0;

  const topErrors: NewRelicData["topErrors"] = topErrorRows.map((row) => ({
    message: (row["error.message"] as string) ?? "unknown",
    count: (row["count"] as number) ?? 0,
  }));

  return { throughput, avgResponse, apdex, errorCount, errorRate, topErrors };
}

// ---------------------------------------------------------------------------
// Convex
// ---------------------------------------------------------------------------

interface ConvexDailyMetrics {
  date: string;
  dau: number;
  newMembers: number;
  totalMembers: number;
  postsCreated: number;
  postsCommunity: number;
  postsSlack: number;
  commentsCreated: number;
  commentsCommunity: number;
  commentsSlack: number;
  reactionsCreated: number;
  dmMessagesSent: number;
  matchesGenerated: number;
  avgMatchScore: number;
  helperActionsReplied: number;
  helperActionsSaved: number;
  helperActionsPassed: number;
  asksResolved: number;
  emailsSent: number;
  emailsFailed: number;
  moderationTotal: number;
  moderationApproved: number;
  moderationFlagged: number;
  moderationBlocked: number;
  karmaEarned: number;
  karmaSpent: number;
  topCommunities: unknown;
}

interface ConvexPlatformMetrics {
  date: string;
  totals: { web: number; mobile: number };
  eventBreakdown: Array<{ event: string; web: number; mobile: number }>;
}

interface ConvexData {
  daily: ConvexDailyMetrics | null;
  platform: ConvexPlatformMetrics | null;
}

async function convexQuery<T>(
  deploymentUrl: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`${deploymentUrl}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fn, args }),
  });

  if (!resp.ok) {
    throw new Error(`Convex ${fn} ${resp.status}: ${await resp.text()}`);
  }

  const body = (await resp.json()) as { value: T; status: string };
  return body.value;
}

async function fetchConvex(yesterday: string): Promise<ConvexData> {
  const url = process.env.CONVEX_DEPLOYMENT_URL;
  if (!url) throw new Error("CONVEX_DEPLOYMENT_URL not set");

  const [dailyRows, platformRows] = await Promise.all([
    convexQuery<ConvexDailyMetrics[]>(url, "dailyMetrics:getRange", {
      from: yesterday,
      to: yesterday,
    }),
    convexQuery<ConvexPlatformMetrics[]>(url, "platformMetrics:getRange", {
      from: yesterday,
      to: yesterday,
    }),
  ]);

  let daily: ConvexDailyMetrics | null = dailyRows?.[0] ?? null;
  let platform: ConvexPlatformMetrics | null = platformRows?.[0] ?? null;

  if (!daily) {
    daily = await convexQuery<ConvexDailyMetrics | null>(
      url, "dailyMetrics:getLatest", {},
    );
    if (daily) {
      log.info(TAG, `no convex daily row for ${yesterday}, using latest (${daily.date})`);
      const latestPlatform = await convexQuery<ConvexPlatformMetrics[]>(
        url, "platformMetrics:getRange", { from: daily.date, to: daily.date },
      );
      platform = latestPlatform?.[0] ?? platform;
    }
  }

  return { daily, platform };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatReport(
  yesterday: string,
  mixpanel: MixpanelData | null,
  mixpanelErr: string | null,
  newRelic: NewRelicData | null,
  newRelicErr: string | null,
  convex: ConvexData | null,
  convexErr: string | null,
): string {
  const lines: string[] = [];
  const heading = prettyDate(yesterday);

  lines.push(`📊 *Web Daily Report · ${heading}*`);
  lines.push("");

  // -- Engagement (Mixpanel) --
  if (mixpanel) {
    const c = mixpanel.counts;
    const ev = (name: string) => n(c[name] ?? 0);
    lines.push("*Engagement* (web)");
    lines.push(
      `events *${n(mixpanel.totalEvents)}*  ·  posts opened *${ev("community.post.opened")}*  ·  searches *${ev("community.search.query_submitted")}*`,
    );
    lines.push(
      `posts created *${ev("community.post.created")}*  ·  comments *${ev("community.comment.created")}*  ·  reactions *${ev("community.reaction.toggled")}*`,
    );
    lines.push(
      `bookmarks *${ev("community.post.bookmark_toggled")}*  ·  notifications clicked *${ev("community.notification.clicked")}*`,
    );
  } else {
    lines.push(`_⚠️ Mixpanel data unavailable: ${mixpanelErr}_`);
  }

  lines.push("");

  // -- Community (Convex daily) --
  if (convex?.daily) {
    const d = convex.daily;
    const dateNote = d.date !== yesterday ? ` _(${prettyDate(d.date)})_` : "";
    lines.push(`*Community*${dateNote}`);
    lines.push(
      `DAU *${n(d.dau)}*  ·  new members *${n(d.newMembers)}*  ·  total *${n(d.totalMembers)}*`,
    );
    lines.push(
      `posts *${n(d.postsCreated)}*  ·  comments *${n(d.commentsCreated)}*  ·  reactions *${n(d.reactionsCreated)}*  ·  DMs *${n(d.dmMessagesSent)}*`,
    );
    lines.push(
      `matches *${n(d.matchesGenerated)}*  ·  asks resolved *${n(d.asksResolved)}*`,
    );
  } else if (convexErr) {
    lines.push(`_⚠️ Convex data unavailable: ${convexErr}_`);
  } else {
    lines.push("_⚠️ No community metrics for yesterday_");
  }

  lines.push("");

  // -- Platform split (Convex platform metrics + Slack from daily) --
  if (convex?.platform && convex?.daily) {
    const web = convex.platform.totals.web;
    const mobile = convex.platform.totals.mobile;
    const slack =
      (convex.daily.postsSlack ?? 0) +
      (convex.daily.commentsSlack ?? 0);
    const total = web + mobile + slack;

    lines.push("*Where activity happened*");
    lines.push(
      `🌐 web *${n(web)}* (${pct(web, total)})   📱 mobile *${n(mobile)}* (${pct(mobile, total)})   💬 slack *${n(slack)}* (${pct(slack, total)})`,
    );
  } else if (convex?.platform) {
    const web = convex.platform.totals.web;
    const mobile = convex.platform.totals.mobile;
    const total = web + mobile;
    lines.push("*Where activity happened*");
    lines.push(
      `🌐 web *${n(web)}* (${pct(web, total)})   📱 mobile *${n(mobile)}* (${pct(mobile, total)})`,
    );
  }

  lines.push("");
  lines.push("—");
  lines.push("");

  // -- Health (New Relic) --
  if (newRelic) {
    lines.push("*Health*");
    lines.push(
      `throughput *${n(newRelic.throughput)}* req  ·  avg response *${newRelic.avgResponse.toFixed(2)}s*  ·  Apdex *${newRelic.apdex.toFixed(2)}*`,
    );
    lines.push(
      `errors *${n(newRelic.errorCount)}* (${newRelic.errorRate.toFixed(1)}%)`,
    );

    if (newRelic.topErrors.length > 0) {
      lines.push("top errors:");
      for (const err of newRelic.topErrors) {
        const msg =
          err.message.length > 60
            ? err.message.slice(0, 57) + "..."
            : err.message;
        lines.push(`  • \`${msg}\` — *${n(err.count)}*`);
      }
    }
  } else {
    lines.push(`_⚠️ New Relic data unavailable: ${newRelicErr}_`);
  }

  // -- Footer --
  if (convex?.daily) {
    const d = convex.daily;
    lines.push("");
    lines.push(
      `_${n(d.totalMembers)} total members  ·  karma +${n(d.karmaEarned)} / −${n(d.karmaSpent)}_`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runWebActivityReport(): Promise<string> {
  const yesterday = yesterdayIST();
  log.info(TAG, `generating web activity report for ${yesterday}`);

  const [mixpanelResult, newRelicResult, convexResult] =
    await Promise.allSettled([
      fetchMixpanel(yesterday),
      fetchNewRelic(),
      fetchConvex(yesterday),
    ]);

  let mixpanel: MixpanelData | null = null;
  let mixpanelErr: string | null = null;
  if (mixpanelResult.status === "fulfilled") {
    mixpanel = mixpanelResult.value;
  } else {
    mixpanelErr = mixpanelResult.reason?.message ?? "unknown error";
    log.warn(TAG, `mixpanel fetch failed: ${mixpanelErr}`);
  }

  let newRelic: NewRelicData | null = null;
  let newRelicErr: string | null = null;
  if (newRelicResult.status === "fulfilled") {
    newRelic = newRelicResult.value;
  } else {
    newRelicErr = newRelicResult.reason?.message ?? "unknown error";
    log.warn(TAG, `new relic fetch failed: ${newRelicErr}`);
  }

  let convex: ConvexData | null = null;
  let convexErr: string | null = null;
  if (convexResult.status === "fulfilled") {
    convex = convexResult.value;
  } else {
    convexErr = convexResult.reason?.message ?? "unknown error";
    log.warn(TAG, `convex fetch failed: ${convexErr}`);
  }

  return formatReport(
    yesterday,
    mixpanel,
    mixpanelErr,
    newRelic,
    newRelicErr,
    convex,
    convexErr,
  );
}
