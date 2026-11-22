import "server-only";
import { db } from "@/server/db/client";
import { Errors } from "@/server/http/errors";
import { getEntitlements } from "@/server/billing/entitlements";
import { PLANS, getDailyCapForPlan, type PlanKey } from "@/server/billing/plans";
import { ensureCurrentGrantForUser } from "@/server/billing/grants";
import { getDailyUsage } from "@/server/services/credits";
import { resolveWorkspaceRole } from "@/server/authz/access";
import { GROUNDING_SURCHARGE_CREDITS } from "@/lib/ai/model-catalog";
import {
  USAGE_KINDS,
  type CreditHistoryEntry,
  type CreditHistoryType,
  type UsageByMemberRow,
  type UsageKind,
  type UsageSummary,
  type UsageTimeseriesPoint,
} from "@/lib/usage/types";

/**
 * Step 9.3: usage dashboard and credit history.
 *
 * Every number is computed from the credit ledger (the source of truth), so
 * the page always equals the ledger: an AI call's cost is the sum of its
 * RESERVE, SETTLE and RELEASE rows. There is no rollup table (the guide's
 * `UsageDaily`): the ledger is indexed by (account, created_at) and one
 * account's rows for a period are few, so no nightly reconcile job is needed.
 *
 * A credit period starts with the grant that set the current allowance
 * (signup, monthly Free, yearly month, paid renewal, plan end). Upgrades add
 * credits inside a period without starting a new one.
 */

/** `grantPlanInTx` reasons: each one replaces the allowance and starts a period. */
export const ALLOWANCE_GRANT_REASONS = [
  "monthly_free",
  "free_monthly",
  "yearly_monthly",
  "subscription.paid",
  "plan_ended",
] as const;

const SPEND_TYPES = ["RESERVE", "SETTLE", "RELEASE"] as const;
/** Longest timeseries range (days). */
export const MAX_TIMESERIES_DAYS = 366;
export const HISTORY_PAGE_SIZE = 50;
export const HISTORY_CSV_MAX_ROWS = 5000;

type AccountRow = {
  id: string;
  planBalance: number;
  topupBalance: number;
  allowancePlan: PlanKey;
  allowanceKey: string | null;
  createdAt: Date;
};

async function requireAccount(userId: string): Promise<AccountRow> {
  const account = await db.creditAccount.findUnique({
    where: { userId },
    select: {
      id: true,
      planBalance: true,
      topupBalance: true,
      allowancePlan: true,
      allowanceKey: true,
      createdAt: true,
    },
  });
  if (!account) throw Errors.notFound("Credit account");
  return account;
}

export interface UsagePeriod {
  start: Date;
  /** Exclusive; null = still running. */
  end: Date | null;
}

/** The current credit period and the one before it (null when there is none). */
export async function getUsagePeriods(
  account: Pick<AccountRow, "id" | "allowanceKey" | "createdAt">
): Promise<{ current: UsagePeriod; previous: UsagePeriod | null }> {
  const grants = await db.creditLedger.findMany({
    where: {
      accountId: account.id,
      type: "GRANT",
      reason: { in: [...ALLOWANCE_GRANT_REASONS] },
    },
    select: { createdAt: true, idempotencyKey: true },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  // The stamped allowance when there is one, else the latest allowance grant.
  const currentIndex = Math.max(
    0,
    grants.findIndex((g) => g.idempotencyKey === account.allowanceKey)
  );
  const currentGrant = grants[currentIndex];
  const start = currentGrant?.createdAt ?? account.createdAt;
  const before = grants[currentIndex + 1];
  return {
    current: { start, end: null },
    previous: before ? { start: before.createdAt, end: start } : null,
  };
}

/** One row per AI call billed to the account inside the window. */
type SpendRow = {
  generation_id: string | null;
  kind: string | null;
  model_key: string | null;
  actor_id: string | null;
  usage: unknown;
  credits: number;
};

async function spendInWindow(accountId: string, window: UsagePeriod): Promise<SpendRow[]> {
  const end = window.end ?? new Date("9999-12-31T00:00:00Z");
  const rows = await db.$queryRaw<
    (Omit<SpendRow, "credits"> & { credits: bigint | number })[]
  >`
    SELECT l.generation_id,
           g.kind::text AS kind,
           g.model_key,
           COALESCE(g.actor_id, MAX(l.actor_id)) AS actor_id,
           g.usage,
           SUM(-(l.plan_delta + l.topup_delta)) AS credits
    FROM credit_ledger l
    LEFT JOIN generations g ON g.id = l.generation_id
    WHERE l.account_id = ${accountId}
      AND l.type::text = ANY(${[...SPEND_TYPES]})
      AND l.created_at >= ${window.start}
      AND l.created_at < ${end}
    GROUP BY l.generation_id, g.id
  `;
  return rows.map((r) => ({ ...r, credits: Number(r.credits) }));
}

export function kindBucket(kind: string | null): UsageKind {
  switch (kind) {
    case "TEXT":
      return "text";
    case "IMAGE":
      return "images";
    case "ANNOTATION_REPLY":
    case "QUESTION_BATCH":
      return "asks";
    case "DOCUMENT_REVIEW":
      return "reviews";
    case "TRANSCRIPTION":
      return "transcription";
    case "SPEECH":
      return "speech";
    default:
      return "other";
  }
}

function usageNumber(usage: unknown, key: string): number {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return 0;
  const v = (usage as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Splits spending by kind and model. Web-search surcharges are taken out of
 * their call's kind and shown on their own, so nothing is counted twice.
 */
export function breakdown(rows: SpendRow[]) {
  const byKind = Object.fromEntries(USAGE_KINDS.map((k) => [k, 0])) as Record<UsageKind, number>;
  const byModel: Record<string, number> = {};
  let searchCredits = 0;
  let searches = 0;
  let transcriptionSeconds = 0;
  let generations = 0;

  for (const row of rows) {
    if (row.credits === 0 && !row.generation_id) continue;
    if (row.credits !== 0) generations += 1;
    const bucket = kindBucket(row.kind);
    const rowSearches = bucket === "text" ? usageNumber(row.usage, "searches") : 0;
    // Never more than the call actually cost (a capped settle charges less).
    const rowSearchCredits = Math.min(Math.max(row.credits, 0), rowSearches * GROUNDING_SURCHARGE_CREDITS);
    searchCredits += rowSearchCredits;
    searches += rowSearches;
    byKind[bucket] += row.credits - rowSearchCredits;
    if (bucket === "transcription") transcriptionSeconds += usageNumber(row.usage, "seconds");
    const model = row.model_key ?? "unknown";
    byModel[model] = (byModel[model] ?? 0) + row.credits;
  }

  return {
    byKind,
    webSearch: { credits: searchCredits, searches },
    transcriptionSeconds: Math.round(transcriptionSeconds),
    byModel: Object.entries(byModel)
      .filter(([, credits]) => credits !== 0)
      .map(([modelKey, credits]) => ({ modelKey, credits }))
      .sort((a, b) => b.credits - a.credits),
    generations,
  };
}

export async function getUsageSummary(
  userId: string,
  period: "current" | "prev" = "current"
): Promise<UsageSummary> {
  // Bring the allowance up to date first (Step 8.4), like the home page does.
  const grant = await ensureCurrentGrantForUser(userId).catch(() => null);
  const account = await requireAccount(userId);
  const [periods, entitlements, usedToday] = await Promise.all([
    getUsagePeriods(account),
    getEntitlements(userId),
    getDailyUsage(account.id),
  ]);
  const window = period === "prev" ? periods.previous : periods.current;
  const rows = window ? await spendInWindow(account.id, window) : [];
  const split = breakdown(rows);
  const used = rows.reduce((sum, r) => sum + r.credits, 0);

  return {
    period,
    periodStart: window?.start.toISOString() ?? null,
    periodEnd: window?.end?.toISOString() ?? null,
    hasPreviousPeriod: periods.previous !== null,
    plan: entitlements.plan,
    allowance: PLANS[account.allowancePlan]?.credits ?? 0,
    used,
    remaining: account.planBalance,
    topup: account.topupBalance,
    resetsAt: grant?.resetsAt?.toISOString() ?? null,
    byKind: split.byKind,
    webSearch: split.webSearch,
    transcriptionSeconds: split.transcriptionSeconds,
    byModel: split.byModel,
    generations: split.generations,
    dailyCap: { used: usedToday, cap: getDailyCapForPlan(entitlements.plan) },
  };
}

/** Credits and AI calls per UTC day, zeros included; at most 366 days. */
export async function getUsageTimeseries(
  userId: string,
  from: Date,
  to: Date
): Promise<UsageTimeseriesPoint[]> {
  const start = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  if (end < start) throw Errors.badRequest("`to` must not be before `from`", "invalid_range");
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_TIMESERIES_DAYS) {
    throw Errors.badRequest(`At most ${MAX_TIMESERIES_DAYS} days`, "range_too_long");
  }
  const account = await requireAccount(userId);
  const endExclusive = new Date(end.getTime() + 86_400_000);
  const rows = await db.$queryRaw<{ day: Date; credits: bigint | number; generations: bigint | number }[]>`
    -- created_at is stored in UTC without a zone: truncate it as is, so the
    -- day doesn't depend on the database session's time zone.
    SELECT date_trunc('day', l.created_at) AS day,
           SUM(-(l.plan_delta + l.topup_delta)) AS credits,
           COUNT(DISTINCT l.generation_id) FILTER (WHERE l.type::text = 'SETTLE') AS generations
    FROM credit_ledger l
    WHERE l.account_id = ${account.id}
      AND l.type::text = ANY(${[...SPEND_TYPES]})
      AND l.created_at >= ${start}
      AND l.created_at < ${endExclusive}
    GROUP BY 1
  `;
  const byDay = new Map(
    rows.map((r) => [
      toDayKey(new Date(r.day)),
      { credits: Number(r.credits), generations: Number(r.generations) },
    ])
  );
  return Array.from({ length: days }, (_, i) => {
    const day = toDayKey(new Date(start.getTime() + i * 86_400_000));
    const hit = byDay.get(day);
    return { day, credits: hit?.credits ?? 0, generations: hit?.generations ?? 0 };
  });
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toDayKey(d: Date): string {
  // Days are UTC (the column holds UTC times): format in UTC.
  return d.toISOString().slice(0, 10);
}

/** Per person billed to this account in the period (the owner's view of collaborators). */
export async function getUsageByMember(
  userId: string,
  period: "current" | "prev" = "current"
): Promise<UsageByMemberRow[]> {
  const account = await requireAccount(userId);
  const periods = await getUsagePeriods(account);
  const window = period === "prev" ? periods.previous : periods.current;
  if (!window) return [];
  const rows = await spendInWindow(account.id, window);

  const byActor = new Map<string, { prompts: number; asks: number; other: number }>();
  for (const row of rows) {
    if (row.credits === 0 || !row.actor_id) continue;
    const entry = byActor.get(row.actor_id) ?? { prompts: 0, asks: 0, other: 0 };
    const bucket = kindBucket(row.kind);
    if (bucket === "text" || bucket === "images") entry.prompts += row.credits;
    else if (bucket === "asks") entry.asks += row.credits;
    else entry.other += row.credits;
    byActor.set(row.actor_id, entry);
  }
  if (byActor.size === 0) return [];

  const users = await db.user.findMany({
    where: { id: { in: [...byActor.keys()] } },
    select: { id: true, name: true, username: true, deletedAt: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return [...byActor.entries()]
    .map(([actorId, v]) => {
      const u = byId.get(actorId);
      return {
        userId: actorId,
        name: u && !u.deletedAt ? u.name : null,
        username: u && !u.deletedAt ? u.username : null,
        isYou: actorId === userId,
        prompts: v.prompts,
        asks: v.asks,
        other: v.other,
        total: v.prompts + v.asks + v.other,
      };
    })
    .sort((a, b) => b.total - a.total);
}

const HISTORY_TYPES: Record<CreditHistoryType, string[]> = {
  all: ["SETTLE", "GRANT", "EXPIRE", "REFUND", "ADJUST"],
  usage: ["SETTLE"],
  grants: ["GRANT"],
  other: ["EXPIRE", "REFUND", "ADJUST"],
};

function encodeCursor(row: { createdAt: Date; id: string }) {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso ?? "");
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Ledger entries a person can read: one line per finished AI call (its net
 * cost) plus grants, expiries, refunds and adjustments. Open reservations and
 * calls that were released in full (cost 0) are left out. Workspace titles
 * are shown only for workspaces the viewer can still open.
 */
export async function listCreditHistory(
  userId: string,
  options: { cursor?: string; type?: CreditHistoryType; limit?: number } = {}
): Promise<{ entries: CreditHistoryEntry[]; nextCursor: string | null }> {
  const account = await requireAccount(userId);
  const limit = Math.min(Math.max(options.limit ?? HISTORY_PAGE_SIZE, 1), HISTORY_CSV_MAX_ROWS);
  const after = decodeCursor(options.cursor);
  const types = HISTORY_TYPES[options.type ?? "all"];

  const rows = await db.creditLedger.findMany({
    where: {
      accountId: account.id,
      type: { in: types as never[] },
      ...(after && {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      type: true,
      planDelta: true,
      topupDelta: true,
      planAfter: true,
      topupAfter: true,
      generationId: true,
      actorId: true,
      reason: true,
      createdAt: true,
    },
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null;

  // A finished call's net cost = its reservation + its settlement.
  const generationIds = page.filter((r) => r.type === "SETTLE" && r.generationId).map((r) => r.generationId!);
  const [reserves, generations] = await Promise.all([
    generationIds.length
      ? db.creditLedger.findMany({
          where: { accountId: account.id, type: "RESERVE", generationId: { in: generationIds } },
          select: { generationId: true, planDelta: true, topupDelta: true },
        })
      : [],
    generationIds.length
      ? db.generation.findMany({
          where: { id: { in: generationIds } },
          select: { id: true, kind: true, modelKey: true, workspaceId: true, actorId: true },
        })
      : [],
  ]);
  const reserveBy = new Map(reserves.map((r) => [r.generationId!, r.planDelta + r.topupDelta]));
  const genBy = new Map(generations.map((g) => [g.id, g]));

  const workspaceIds = [...new Set(generations.map((g) => g.workspaceId).filter((w): w is string => Boolean(w)))];
  const visible = new Map<string, string>();
  await Promise.all(
    workspaceIds.map(async (wsId) => {
      const access = await resolveWorkspaceRole(userId, wsId).catch(() => null);
      if (!access) return;
      const ws = await db.workspace.findUnique({ where: { id: wsId }, select: { title: true } });
      if (ws) visible.set(wsId, ws.title);
    })
  );

  const actorIds = [...new Set(generations.map((g) => g.actorId).filter((a) => a !== userId))];
  const actors = actorIds.length
    ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, deletedAt: true } })
    : [];
  const actorName = new Map(actors.map((a) => [a.id, a.deletedAt ? null : a.name]));

  const entries: CreditHistoryEntry[] = [];
  for (const row of page) {
    const delta = row.planDelta + row.topupDelta;
    if (row.type === "SETTLE") {
      const gen = row.generationId ? genBy.get(row.generationId) : undefined;
      const amount = delta + (row.generationId ? (reserveBy.get(row.generationId) ?? 0) : 0);
      if (amount === 0) continue;
      entries.push({
        id: row.id,
        at: row.createdAt.toISOString(),
        type: "usage",
        label: kindBucket(gen?.kind ?? null),
        amount,
        balanceAfter: row.planAfter + row.topupAfter,
        modelKey: gen?.modelKey ?? null,
        workspaceId: gen?.workspaceId && visible.has(gen.workspaceId) ? gen.workspaceId : null,
        workspaceTitle: gen?.workspaceId ? (visible.get(gen.workspaceId) ?? null) : null,
        actorName: gen && gen.actorId !== userId ? (actorName.get(gen.actorId) ?? null) : null,
        byOther: Boolean(gen && gen.actorId !== userId),
      });
    } else {
      entries.push({
        id: row.id,
        at: row.createdAt.toISOString(),
        type: row.type === "GRANT" ? "grant" : row.type === "EXPIRE" ? "expire" : row.type === "REFUND" ? "refund" : "adjust",
        label: historyReasonLabel(row.type, row.reason),
        amount: delta,
        balanceAfter: row.planAfter + row.topupAfter,
        modelKey: null,
        workspaceId: null,
        workspaceTitle: null,
        actorName: null,
        byOther: false,
      });
    }
  }
  return { entries, nextCursor };
}

/** A stable label key for non-usage rows (translated in the UI and the CSV). */
export function historyReasonLabel(type: string, reason: string | null): string {
  if (type === "GRANT") {
    switch (reason) {
      case "monthly_free":
        return "signupGrant";
      case "free_monthly":
      case "yearly_monthly":
        return "monthlyAllowance";
      case "subscription.paid":
        return "planAllowance";
      case "plan_upgrade":
        return "planUpgrade";
      case "plan_ended":
        return "planEnded";
      default:
        return "grant";
    }
  }
  if (type === "EXPIRE") return reason === "plan_ended" ? "expiredPlanEnded" : "expired";
  if (type === "REFUND") return "refund";
  return "adjustment";
}
