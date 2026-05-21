import type { Config } from "../config.ts";
import { runnerTimeoutMs, spawnRunner } from "../runners/index.ts";
import type { SpawnRunnerFn } from "../runners/types.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import { createSession } from "../session/types.ts";
import type { WorklogActivity, WorklogCommit, WorklogPr } from "./activity.ts";

export type SummarizeWithAgent = (
  activity: WorklogActivity,
) => Promise<string | null>;

export function formatWorklogSlackSummary(activity: WorklogActivity): string {
  const groups = groupActivity(activity);
  const lines = ["*Worklog* :white_check_mark:"];

  if (groups.size === 0) {
    lines.push("> No tracked PR or commit activity");
  }

  for (const [repo, group] of groups) {
    lines.push(`> ${repo}`);
    for (const pr of group.prs.slice(0, 6)) {
      lines.push(`- ${prSummary(pr)}`);
    }
    const commitOnly = group.commits
      .filter((commit) => !isLikelyCoveredByPr(commit, group.prs))
      .slice(0, 6);
    if (commitOnly.length > 0) {
      lines.push("- Commits");
      for (const commit of commitOnly) {
        lines.push(`  - ${cleanSubject(commit.subject)} (${commit.shortHash})`);
      }
    }
  }

  if (activity.errors.length > 0) {
    lines.push("> Collection notes");
    for (const error of activity.errors.slice(0, 4)) {
      lines.push(`- ${error}`);
    }
  }

  return lines.join("\n");
}

export async function summarizeWorklogWithRunner(
  activity: WorklogActivity,
  config: Config,
  spawn: SpawnRunnerFn = spawnRunner,
): Promise<string | null> {
  const channel = config.worklog.channel ?? "worklog-cron";
  const session = createSession(
    `cron-worklog-${activity.until.slice(0, 10)}`,
    channel,
    "quiet",
    config.runner.provider,
    config.claude.defaultDriver,
  );
  session.cwd = process.cwd();
  session.agentType = "worklog";
  session.activeAgentName = "worklog";
  session.systemPrompt = [
    "You turn raw GitHub PR and git commit activity into a concise Slack work update.",
    "Group related work under short project or feature headings.",
    "Prefer human-readable outcomes over commit-by-commit detail.",
    "Use Slack mrkdwn only. No preamble, no code block.",
    "Use this shape:",
    "*Worklog* :white_check_mark:",
    "> Project or feature",
    "- Outcome :white_check_mark:",
    "  - Supporting detail",
  ].join("\n");

  const handle = spawn(
    session,
    [
      "Summarize this activity for Slack. Keep it compact and grouped.",
      "Do not invent work. If there is no activity, say so plainly.",
      "",
      JSON.stringify(activity, null, 2),
    ].join("\n"),
    config,
  );

  const boundedHandle = withTimeout(
    handle,
    runnerTimeoutMs(config, handle.provider),
    () => handle.kill(),
  );
  const result = await boundedHandle.result;
  if (result.exitCode !== 0 || result.error) return null;
  const response = result.response.trim();
  return response || null;
}

interface ActivityGroup {
  prs: WorklogPr[];
  commits: WorklogCommit[];
}

function groupActivity(activity: WorklogActivity): Map<string, ActivityGroup> {
  const groups = new Map<string, ActivityGroup>();
  for (const repo of activity.repos) {
    groups.set(labelRepo(repo), { prs: [], commits: [] });
  }
  for (const pr of activity.prs) {
    getGroup(groups, labelRepo(pr.repo)).prs.push(pr);
  }
  for (const commit of activity.commits) {
    getGroup(groups, labelRepo(commit.repo)).commits.push(commit);
  }
  for (const [key, value] of [...groups]) {
    if (value.prs.length === 0 && value.commits.length === 0) {
      groups.delete(key);
    }
  }
  return groups;
}

function getGroup(groups: Map<string, ActivityGroup>, key: string): ActivityGroup {
  let group = groups.get(key);
  if (!group) {
    group = { prs: [], commits: [] };
    groups.set(key, group);
  }
  return group;
}

function prSummary(pr: WorklogPr): string {
  const state = pr.mergedAt
    ? "merged"
    : pr.state.toLowerCase() === "open"
      ? "open"
      : pr.state.toLowerCase();
  const suffix = pr.mergedAt ? " :white_check_mark:" : "";
  return `${cleanSubject(pr.title)} (${state} PR #${pr.number})${suffix}`;
}

function isLikelyCoveredByPr(commit: WorklogCommit, prs: WorklogPr[]): boolean {
  const subject = cleanSubject(commit.subject).toLowerCase();
  return prs.some((pr) => {
    const title = cleanSubject(pr.title).toLowerCase();
    return title.includes(subject) || subject.includes(title);
  });
}

function cleanSubject(subject: string): string {
  return subject
    .replace(/^merge pull request #\d+ from \S+\s*/i, "")
    .replace(/^\w+\([^)]+\):\s*/, "")
    .replace(/^\w+:\s*/, "")
    .trim();
}

function labelRepo(repo: string): string {
  return repo
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
