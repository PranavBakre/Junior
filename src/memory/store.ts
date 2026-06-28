import type {
  CandidateRuleInput,
  ClaimInput,
  ClaimRecallOptions,
  ClaimRecallResult,
  ConsolidationOptions,
  ConsolidationResult,
  EpisodeInput,
  IngestionClassificationInput,
  IngestionCorrectionInput,
  MemoryEdgeInput,
  MemoryEventInput,
  MemoryFactInput,
  MemoryFactUpdate,
  MemoryLessonInput,
  MemoryLessonUpdate,
  MemoryMergeResult,
  MemoryRecallOptions,
  MemorySearchResult,
  MemorySourceRecord,
} from "./types.ts";

export interface AcceptedRule {
  id: string;
  domain: "tag" | "event_type" | "edge" | "promotion" | "archive" | "routing_fact";
  ruleText: string;
}

export interface MemoryStore {
  close(): void;
  appendSourceRecord(record: MemorySourceRecord): Promise<void>;
  upsertEvent(event: MemoryEventInput): Promise<void>;
  upsertLesson(lesson: MemoryLessonInput): Promise<void>;
  updateLesson(id: string, update: MemoryLessonUpdate): Promise<void>;
  mergeLessons(ids: string[], title: string): Promise<MemoryMergeResult>;
  upsertFact(fact: MemoryFactInput): Promise<void>;
  updateFact(id: string, update: MemoryFactUpdate): Promise<void>;
  mergeFacts(ids: string[], title: string): Promise<MemoryMergeResult>;
  archiveMemory(id: string): Promise<boolean>;
  addEdge(edge: MemoryEdgeInput): Promise<void>;
  logClassification(classification: IngestionClassificationInput): Promise<void>;
  logCorrection(correction: IngestionCorrectionInput): Promise<void>;
  proposeRule(rule: CandidateRuleInput): Promise<void>;
  setRuleStatus(id: string, status: "accepted" | "rejected"): Promise<boolean>;
  getAcceptedRules(): Promise<AcceptedRule[]>;
  recall(options: MemoryRecallOptions): Promise<MemorySearchResult[]>;
  consolidate(options?: ConsolidationOptions): Promise<ConsolidationResult>;
  rebuildSearchIndex(): Promise<void>;
  // memory v3: semantic claim store + raw episode log
  upsertClaim(claim: ClaimInput): Promise<void>;
  appendEpisode(episode: EpisodeInput): Promise<void>;
  recallClaims(options: ClaimRecallOptions): Promise<ClaimRecallResult[]>;
}
