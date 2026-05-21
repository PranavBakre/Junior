import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import { log } from "../logger.ts";
import {
  collectWorklogActivity,
  writeWorklogDoc,
  type RunCommand,
  type WorklogActivity,
} from "./activity.ts";
import {
  formatWorklogSlackSummary,
  summarizeWorklogWithRunner,
  type SummarizeWithAgent,
} from "./summary.ts";

export interface RunWorklogJobOptions {
  config: Config;
  app: App;
  now?: Date;
  runCommand?: RunCommand;
  summarizeWithAgent?: SummarizeWithAgent;
}

export interface WorklogJobResult {
  activity: WorklogActivity;
  docPath: string;
  slackSummary: string;
  posted: boolean;
}

export async function runWorklogJob(
  options: RunWorklogJobOptions,
): Promise<WorklogJobResult> {
  const now = options.now ?? new Date();
  const since = new Date(
    now.getTime() - options.config.worklog.lookbackHours * 60 * 60 * 1000,
  );
  const activity = await collectWorklogActivity({
    repos: options.config.repos,
    since,
    until: now,
    gitAuthor: options.config.worklog.gitAuthor,
    githubUser: options.config.worklog.githubUser,
    runCommand: options.runCommand,
  });

  const deterministicSummary = formatWorklogSlackSummary(activity);
  let slackSummary = deterministicSummary;

  if (options.config.worklog.useAgent) {
    try {
      const agentSummary = await (options.summarizeWithAgent
        ? options.summarizeWithAgent(activity)
        : summarizeWorklogWithRunner(activity, options.config));
      if (agentSummary) slackSummary = agentSummary;
    } catch (err) {
      log.warn(
        "worklog",
        `agent summary failed; using deterministic summary: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const docPath = await writeWorklogDoc(
    activity,
    options.config.worklog.docsDir,
    slackSummary,
  );

  const posted = await postWorklogToSlack(options.app, options.config, slackSummary);
  log.info(
    "worklog",
    `complete commits=${activity.commits.length} prs=${activity.prs.length} errors=${activity.errors.length} doc=${docPath} posted=${posted}`,
  );

  return { activity, docPath, slackSummary, posted };
}

async function postWorklogToSlack(
  app: App,
  config: Config,
  text: string,
): Promise<boolean> {
  if (!config.worklog.channel) return false;
  await app.client.chat.postMessage({
    channel: config.worklog.channel,
    text,
    ...(config.worklog.threadTs ? { thread_ts: config.worklog.threadTs } : {}),
  });
  return true;
}
