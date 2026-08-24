import { WebClient } from "@slack/web-api";
import {
  compareSlackDeploymentIdentity,
  expectedSlackDeploymentIdentity,
  fetchSlackDeploymentIdentity,
  loadExpectedSlackDeploymentIdentity,
  persistExpectedSlackDeploymentIdentity,
  type ExpectedSlackDeploymentIdentity,
} from "./deployment-identity.ts";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) throw new Error("SLACK_BOT_TOKEN is required");

const path = process.env.SLACK_DEPLOYMENT_IDENTITY_PATH ?? "data/slack-deployment-identity.json";
const command = process.argv[2] ?? "doctor";
const client = new WebClient(token);
const identity = await fetchSlackDeploymentIdentity(client);

if (command === "setup") {
  const configuredChannels = (process.env.SLACK_EXPECTED_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const expected: ExpectedSlackDeploymentIdentity = {
    ...identity,
    ...(configuredChannels.length ? { joinedChannelIds: configuredChannels } : { joinedChannelIds: [] }),
  };
  const check = compareSlackDeploymentIdentity(identity, expected);
  if (check.errors.length > 0) throw new Error(check.errors.join("; "));
  persistExpectedSlackDeploymentIdentity(expected, path);
  console.log(`Pinned Slack deployment identity at ${path}`);
  console.log(JSON.stringify(expected, null, 2));
} else if (command === "doctor") {
  const expected = expectedSlackDeploymentIdentity(
    {
      expectedUserId: process.env.SLACK_EXPECTED_USER_ID,
      expectedBotId: process.env.SLACK_EXPECTED_BOT_ID,
      expectedTeamId: process.env.SLACK_EXPECTED_TEAM_ID,
      expectedVisibleName: process.env.SLACK_EXPECTED_VISIBLE_NAME,
      expectedChannelIds: (process.env.SLACK_EXPECTED_CHANNEL_IDS ?? "")
        .split(",").map((id) => id.trim()).filter(Boolean),
    },
    loadExpectedSlackDeploymentIdentity(path),
  );
  const check = compareSlackDeploymentIdentity(identity, expected);
  if (check.errors.length > 0) {
    console.error(check.errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Slack deployment identity is valid: ${identity.userId} ${identity.visibleName}`);
  }
} else {
  throw new Error(`Unknown command ${command}; expected setup or doctor`);
}
