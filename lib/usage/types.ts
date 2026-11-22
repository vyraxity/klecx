/**
 * Step 9.3: shapes shared by the usage API and the Settings → Usage page.
 */

/** Spending categories (Asks = annotation replies + question batches). */
export const USAGE_KINDS = ["text", "images", "asks", "reviews", "transcription", "speech", "other"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const CREDIT_HISTORY_TYPES = ["all", "usage", "grants", "other"] as const;
export type CreditHistoryType = (typeof CREDIT_HISTORY_TYPES)[number];

export interface UsageSummary {
  period: "current" | "prev";
  periodStart: string | null;
  /** Null while the period is running. */
  periodEnd: string | null;
  hasPreviousPeriod: boolean;
  plan: string;
  /** The period's allowance (the plan's monthly credits). */
  allowance: number;
  /** Credits spent in the period (from the ledger). */
  used: number;
  /** Plan credits left now. */
  remaining: number;
  topup: number;
  resetsAt: string | null;
  /** Credits per kind, web-search surcharges excluded (they're in `webSearch`). */
  byKind: Record<UsageKind, number>;
  webSearch: { credits: number; searches: number };
  transcriptionSeconds: number;
  byModel: { modelKey: string; credits: number }[];
  /** AI calls that cost credits in the period. */
  generations: number;
  dailyCap: { used: number; cap: number };
}

export interface UsageTimeseriesPoint {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  credits: number;
  generations: number;
}

export interface UsageByMemberRow {
  userId: string;
  /** Null for a deleted account. */
  name: string | null;
  username: string | null;
  isYou: boolean;
  /** Main prompts (text and images). */
  prompts: number;
  /** Asks (highlight questions and the question queue). */
  asks: number;
  /** Everything else (reviews, titles…). */
  other: number;
  total: number;
}

export interface CreditHistoryEntry {
  id: string;
  at: string;
  type: "usage" | "grant" | "expire" | "refund" | "adjust";
  /** A UsageKind for usage rows, else a reason key (`Usage.history.reasons.*`). */
  label: string;
  /** Signed: negative = spent. */
  amount: number;
  balanceAfter: number;
  modelKey: string | null;
  workspaceId: string | null;
  /** Only when the viewer can still open the workspace. */
  workspaceTitle: string | null;
  actorName: string | null;
  /** The call was made by someone else (a collaborator in your workspace). */
  byOther: boolean;
}
