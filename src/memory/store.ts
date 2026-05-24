import type {
  CandidateRuleInput,
  ConsolidationOptions,
  ConsolidationResult,
  IngestionClassificationInput,
  IngestionCorrectionInput,
  MemoryEdgeInput,
  MemoryEventInput,
  MemoryFactInput,
  MemoryLessonInput,
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
  upsertFact(fact: MemoryFactInput): Promise<void>;
  addEdge(edge: MemoryEdgeInput): Promise<void>;
  logClassification(classification: IngestionClassificationInput): Promise<void>;
  logCorrection(correction: IngestionCorrectionInput): Promise<void>;
  proposeRule(rule: CandidateRuleInput): Promise<void>;
  acceptRule(id: string): Promise<boolean>;
  rejectRule(id: string): Promise<boolean>;
  getAcceptedRules(): Promise<AcceptedRule[]>;
  search(query: string, options?: { limit?: number }): Promise<MemorySearchResult[]>;
  recall(options: MemoryRecallOptions): Promise<MemorySearchResult[]>;
  consolidate(options?: ConsolidationOptions): Promise<ConsolidationResult>;
  rebuildSearchIndex(): Promise<void>;
}
