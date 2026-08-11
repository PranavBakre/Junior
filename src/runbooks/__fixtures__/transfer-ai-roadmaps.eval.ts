import type { EvaluationFixture } from "../evaluation.ts";

export const TRANSFER_AI_ROADMAPS_FIXTURES: EvaluationFixture[] = [
  {
    request: "move my AI roadmaps from A to B",
    shouldMatch: true,
    expectedRunbook: "transfer-ai-roadmaps",
  },
  {
    request: "transfer all AI roadmaps from alice@example.com to bob@example.com",
    shouldMatch: true,
    expectedRunbook: "transfer-ai-roadmaps",
  },
  {
    request: "move all roadmaps in prod from one account to another",
    shouldMatch: true,
    expectedRunbook: "transfer-ai-roadmaps",
  },
  {
    request: "move one Notion roadmap to another workspace",
    shouldMatch: false,
  },
  {
    request: "transfer every document owned by a user",
    shouldMatch: false,
  },
  {
    request: "delete all roadmaps for this user",
    shouldMatch: false,
  },
  {
    request: "list all AI roadmaps",
    shouldMatch: false,
  },
];
