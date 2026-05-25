export type MemorySourceKind =
  | "slack_message"
  | "runner_output"
  | "routing_decision"
  | "routing_correction"
  | "ingestion_correction"
  | "curated_fact"
  | "manual_correction";

export type MemoryNodeKind =
  | "event"
  | "lesson"
  | "summary"
  | "fact"
  | "procedure"
  | "routing_memory"
  | "entity"
  | "tag";

export type SearchableMemoryKind = Exclude<MemoryNodeKind, "entity" | "tag">;

export interface MemorySourceRecord {
  id: string;
  kind: MemorySourceKind;
  channelId?: string | null;
  threadId?: string | null;
  slackTs?: string | null;
  sourceUrl?: string | null;
  actorId?: string | null;
  actorKind?: "human" | "junior" | "agent" | "bot" | "system" | null;
  agentName?: string | null;
  repoName?: string | null;
  body: string;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

export interface MemoryEventInput {
  id: string;
  sourceRecordId: string;
  threadId: string;
  body: string;
  summaryId?: string | null;
  outcome?: string | null;
  importance?: number;
  createdAt: number;
  sourceTs?: string | null;
  sourceUrl?: string | null;
  tags?: string[];
  entities?: Array<{ name: string; kind: string }>;
}

export interface MemoryLessonInput {
  id: string;
  title: string;
  body: string;
  appliesWhen?: string | null;
  importance?: number;
  createdAt: number;
  sourceIds?: string[];
  tags?: string[];
  entities?: Array<{ name: string; kind: string }>;
}

export interface MemoryFactInput {
  id: string;
  kind: "curated_fact" | "routing_memory" | "procedure";
  title?: string | null;
  body: string;
  confidence?: number;
  importance?: number;
  createdAt: number;
  sourceIds?: string[];
  tags?: string[];
  entities?: Array<{ name: string; kind: string }>;
}

export interface MemoryEdgeInput {
  srcId: string;
  dstId: string;
  type:
    | "lesson_from"
    | "same_topic"
    | "follows_up"
    | "contradicts"
    | "supersedes"
    | "merged_from"
    | "mentions"
    | "tagged_as"
    | "applies_to"
    | string;
  weight?: number;
  directed?: boolean;
  createdAt: number;
}

export interface MemoryLessonUpdate {
  title?: string | null;
  body?: string | null;
  appliesWhen?: string | null;
  importance?: number | null;
  addSourceIds?: string[];
  addTags?: string[];
  addEntities?: Array<{ name: string; kind: string }>;
}

export interface MemoryFactUpdate {
  kind?: "curated_fact" | "routing_memory" | "procedure" | null;
  title?: string | null;
  body?: string | null;
  confidence?: number | null;
  importance?: number | null;
  addSourceIds?: string[];
  addTags?: string[];
  addEntities?: Array<{ name: string; kind: string }>;
}

export interface MemoryMergeResult {
  mergedId: string;
  kind: "lesson" | "fact";
  sourceIds: string[];
  supersededIds: string[];
}

export interface MemoryRecallOptions {
  query?: string;
  tags?: string[];
  entities?: string[];
  kinds?: SearchableMemoryKind[];
  limit?: number;
  depth?: number;
  includeInactive?: boolean;
  includeInvalid?: boolean;
}

export interface MemorySearchResult {
  id: string;
  kind: SearchableMemoryKind;
  title: string | null;
  body: string;
  outcome: string | null;
  score: number;
  reasons: string[];
  sourceIds: string[];
}

export interface IngestionClassificationInput {
  eventId: string;
  inputText: string;
  extractedMentions: string[];
  assignedTags: string[];
  assignedEventTypes: string[];
  createdEdges: Array<{ src: string; dst: string; type: string }>;
  extractor: "capture" | "heuristic" | "llm" | "manual" | "learned_rule";
  confidence: number;
  createdAt: number;
}

export interface IngestionCorrectionInput {
  eventId: string;
  field: "tag" | "event_type" | "edge" | "promotion" | "archive" | "routing_fact" | "validity";
  incorrectValue?: string | null;
  correctValue?: string | null;
  correctedBy: "user" | "agent" | "reviewer";
  createdAt: number;
}

export interface ConsolidationDecisionRecord {
  id: string;
  eventId: string;
  action: "promote_lesson" | "promote_fact" | "promote_routing_memory" | "archive" | "mark_stale" | "propose_rule" | "prune_edges" | "summarize";
  reason: string;
  sourceIds: string[];
  extractor: "heuristic" | "llm" | "manual" | "learned_rule";
  createdAt: number;
}

export interface CandidateRuleInput {
  id: string;
  status?: "draft" | "accepted" | "rejected";
  domain: "tag" | "event_type" | "edge" | "promotion" | "archive" | "routing_fact";
  ruleText: string;
  positiveExampleIds: string[];
  negativeExampleIds: string[];
  precision?: number | null;
  recall?: number | null;
  createdAt: number;
}

export interface ConsolidationOptions {
  now?: number;
  archiveBeforeMs?: number;
  lowImportanceThreshold?: number;
  repeatedCorrectionThreshold?: number;
}

export interface ConsolidationResult {
  decisions: ConsolidationDecisionRecord[];
  promotedMemoryIds: string[];
  archivedEventIds: string[];
  proposedRuleIds: string[];
}
