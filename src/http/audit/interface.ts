export type DashboardAuditResult =
  | "received"
  | "ok"
  | "buffered"
  | "skipped"
  | "error"
  | "denied"
  | "partial";

export type DashboardAuditEntry = {
  id: string;
  at: number;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  request: Record<string, unknown>;
  result: string;
  error: string | null;
  slackTs: string | null;
  commitSha: string | null;
};

export type DashboardAuditRecordInput = {
  id?: string;
  at?: number;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  request?: Record<string, unknown>;
  result: string;
  error?: string | null;
  slackTs?: string | null;
  commitSha?: string | null;
};

export interface DashboardAuditStore {
  record(entry: DashboardAuditRecordInput): Promise<DashboardAuditEntry>;
  list(filter?: {
    action?: string;
    targetType?: string;
    from?: number;
    to?: number;
    limit?: number;
  }): Promise<DashboardAuditEntry[]>;
  deleteOlderThan(at: number): Promise<number>;
  close?(): void;
}
