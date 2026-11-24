import "server-only";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { log, errInfo } from "@/server/log";
import { sendEmail } from "@/server/email/send";
import { DAILY_SEARCH_REQUEST_CAP, generationCostUsd } from "@/server/monitoring/costs";
import { countSearchRequests, startOfUtcDay } from "@/server/monitoring/search-usage";
import { readCreemEventData } from "@/server/billing/creem";
import type { Prisma } from "@/server/db/generated/client";

/**
 * Step 10.2 — alerts. `runAlertChecks()` looks at the last hour/day of data,
 * records every firing condition in `monitoring_alerts` and emails the new
 * ones to `ALERTS_EMAIL` (default: the billing inbox). The same alert isn't
 * emailed again before its quiet period ends (1 h critical, 6 h warning).
 *
 * Run by an admin (`POST /api/v1/admin/alerts/run`) and, from Step 10.3, every
 * hour by the job runner. Error spikes in the code itself are Sentry's job
 * (alert rules in its dashboard).
 */

export type AlertKind =
  | "providerErrors"
  | "providerAuth"
  | "providerQuota"
  | "webhookFailures"
  | "accountCost"
  | "costVsRevenue"
  | "limitAbuse"
  | "stuckGenerations"
  | "dbConnections"
  | "searchCapNear"
  | "searchCapReached";

export interface Alert {
  key: string;
  kind: AlertKind;
  severity: "critical" | "warning";
  values: Record<string, string | number>;
}

/** Thresholds, in one place. */
export const ALERT_THRESHOLDS = {
  /** Provider failures in the last hour: at least this many calls, and this share failing. */
  providerMinCalls: 10,
  providerFailureRate: 0.25,
  /** Quota / rate-limit refusals in the last hour. */
  providerQuotaCount: 3,
  /** Provider cost of one account in 24 h, USD, by plan (guide: $2 on Free/Lite). */
  accountCostUsd: { FREE: 2, LITE: 2, STANDARD: 5, PRO: 10 } as Record<string, number>,
  /** Daily cost above this share of the average daily revenue (last 30 days). */
  costToRevenue: 0.6,
  /** A person hitting a plan limit on this many different days out of the last 7. */
  limitAbuseDays: 3,
  /** A generation still RUNNING after this long. */
  stuckMinutes: 15,
  /** Database connections in use, as a share of the maximum. */
  dbConnectionShare: 0.8,
  /** Webhook events still RECEIVED (not processed) after this long. */
  webhookStuckMinutes: 15,
  /** Share of the provider's daily cap on grounded searches (1,500, account-wide) that warns. */
  searchCapShare: 0.8,
};

const QUIET_MS = { critical: 60 * 60_000, warning: 6 * 60 * 60_000 };
const PROVIDER_CATEGORIES = new Set(["rate_limit", "unavailable", "timeout", "unknown", "auth", "invalid_request"]);
const ANSWER_KINDS = ["TEXT", "ANNOTATION_REPLY", "QUESTION_BATCH", "DOCUMENT_REVIEW"] as const;

const pct = (n: number) => Math.round(n * 100);
const usd = (n: number) => Math.round(n * 100) / 100;

/** Every condition that's true right now (pure reads; nothing is written). */
export async function evaluateAlerts(now: Date = new Date()): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);

  // 1. The AI provider: failure rate, revoked key, quota.
  const recent = await db.generation.findMany({
    where: { createdAt: { gte: hourAgo, lte: now }, kind: { in: [...ANSWER_KINDS] }, status: { in: ["COMPLETED", "FAILED"] } },
    select: { status: true, errorCode: true },
  });
  const providerFailures = recent.filter((g) => g.status === "FAILED" && PROVIDER_CATEGORIES.has(g.errorCode ?? ""));
  if (recent.length >= ALERT_THRESHOLDS.providerMinCalls && providerFailures.length / recent.length >= ALERT_THRESHOLDS.providerFailureRate) {
    alerts.push({
      key: "provider_errors",
      kind: "providerErrors",
      severity: "critical",
      values: { failed: providerFailures.length, total: recent.length, rate: pct(providerFailures.length / recent.length) },
    });
  }
  const authFailures = providerFailures.filter((g) => g.errorCode === "auth").length;
  if (authFailures > 0) {
    alerts.push({ key: "provider_auth", kind: "providerAuth", severity: "critical", values: { count: authFailures } });
  }
  const quota = providerFailures.filter((g) => g.errorCode === "rate_limit").length;
  if (quota >= ALERT_THRESHOLDS.providerQuotaCount) {
    alerts.push({ key: "provider_quota", kind: "providerQuota", severity: "critical", values: { count: quota } });
  }

  // 2. Billing webhooks that failed, or arrived and were never processed.
  const [failedWebhooks, stuckWebhooks] = await Promise.all([
    db.billingEvent.count({ where: { status: "FAILED", receivedAt: { gte: dayAgo, lte: now } } }),
    db.billingEvent.count({
      where: { status: "RECEIVED", receivedAt: { lt: new Date(now.getTime() - ALERT_THRESHOLDS.webhookStuckMinutes * 60_000) } },
    }),
  ]);
  if (failedWebhooks + stuckWebhooks > 0) {
    alerts.push({ key: "webhook_failures", kind: "webhookFailures", severity: "critical", values: { failed: failedWebhooks, stuck: stuckWebhooks } });
  }

  // 3. One account's provider cost in 24 h, and 4. the day's cost against revenue.
  const day = await db.generation.findMany({
    where: { createdAt: { gte: dayAgo, lte: now } },
    select: { kind: true, modelKey: true, status: true, usage: true, createdAt: true, billedAccountId: true },
  });
  const perAccount = new Map<string, number>();
  let dayCost = 0;
  for (const g of day) {
    const c = generationCostUsd(g);
    dayCost += c;
    perAccount.set(g.billedAccountId, (perAccount.get(g.billedAccountId) ?? 0) + c);
  }
  if (perAccount.size) {
    const accounts = await db.creditAccount.findMany({
      where: { id: { in: [...perAccount.keys()] } },
      select: { id: true, userId: true, allowancePlan: true },
    });
    for (const a of accounts) {
      const cost = perAccount.get(a.id) ?? 0;
      const limit = ALERT_THRESHOLDS.accountCostUsd[a.allowancePlan] ?? ALERT_THRESHOLDS.accountCostUsd.FREE!;
      if (cost > limit) {
        alerts.push({
          key: `account_cost:${a.userId}`,
          kind: "accountCost",
          severity: "warning",
          values: { userId: a.userId, plan: a.allowancePlan, usd: usd(cost), limit },
        });
      }
    }
  }
  if (env.BILLING_ENABLED) {
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const paid = await db.billingEvent.findMany({
      where: { type: "subscription.paid", receivedAt: { gte: monthAgo, lte: now } },
      select: { type: true, payload: true },
    });
    let revenue = 0;
    for (const e of paid) {
      const obj = e.payload && typeof e.payload === "object" ? (e.payload as { object?: unknown }).object : undefined;
      revenue += (readCreemEventData(e.type, obj).transaction?.amountPaid ?? 0) / 100;
    }
    const dailyRevenue = revenue / 30;
    if (dailyRevenue > 0 && dayCost > ALERT_THRESHOLDS.costToRevenue * dailyRevenue) {
      alerts.push({
        key: "cost_vs_revenue",
        kind: "costVsRevenue",
        severity: "warning",
        values: { costUsd: usd(dayCost), revenueUsd: usd(dailyRevenue), pct: pct(dayCost / dailyRevenue) },
      });
    }
  }

  // 5. Someone hitting a plan limit day after day (abuse or a plan that's too small).
  const weekAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
  const hits = await db.usageLimitHit.groupBy({
    by: ["userId", "kind"],
    where: { day: { gte: weekAgo, lte: now } },
    _count: { _all: true },
  });
  for (const h of hits) {
    if (h._count._all >= ALERT_THRESHOLDS.limitAbuseDays) {
      alerts.push({
        key: `limit_abuse:${h.userId}:${h.kind}`,
        kind: "limitAbuse",
        severity: "warning",
        values: { userId: h.userId, limit: h.kind, days: h._count._all },
      });
    }
  }

  // 6. Generations stuck in RUNNING (a crashed function; the 10.3 job cleans them up).
  const stuck = await db.generation.count({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - ALERT_THRESHOLDS.stuckMinutes * 60_000) } },
  });
  if (stuck > 0) alerts.push({ key: "stuck_generations", kind: "stuckGenerations", severity: "warning", values: { count: stuck } });

  // 7. The provider's daily cap on grounded searches (1,500 for all of Klecx,
  //    UTC day): searches stop for everyone once it's reached (OPEN_DECISIONS §18).
  const searchesToday = await countSearchRequests(startOfUtcDay(now), new Date(now.getTime() + 1));
  if (searchesToday.requests >= DAILY_SEARCH_REQUEST_CAP) {
    alerts.push({
      key: "search_cap_reached",
      kind: "searchCapReached",
      severity: "critical",
      values: { requests: searchesToday.requests, cap: DAILY_SEARCH_REQUEST_CAP },
    });
  } else if (searchesToday.requests >= ALERT_THRESHOLDS.searchCapShare * DAILY_SEARCH_REQUEST_CAP) {
    alerts.push({
      key: "search_cap_near",
      kind: "searchCapNear",
      severity: "warning",
      values: { requests: searchesToday.requests, cap: DAILY_SEARCH_REQUEST_CAP, pct: pct(searchesToday.requests / DAILY_SEARCH_REQUEST_CAP) },
    });
  }

  // 8. Database connections near the limit (skipped where the host hides these views).
  try {
    const rows = await db.$queryRaw<{ used: bigint | number; max: string }[]>`
      SELECT (SELECT count(*) FROM pg_stat_activity) AS used, current_setting('max_connections') AS max`;
    const used = Number(rows[0]?.used ?? 0);
    const max = Number(rows[0]?.max ?? 0);
    if (max > 0 && used / max >= ALERT_THRESHOLDS.dbConnectionShare) {
      alerts.push({ key: "db_connections", kind: "dbConnections", severity: "critical", values: { used, max } });
    }
  } catch {
    // Not available on this host.
  }

  return alerts;
}

/**
 * Evaluates, records and emails. Returns what fired and what was emailed.
 * Idempotent within the quiet periods, so running it often is safe.
 */
export async function runAlertChecks(now: Date = new Date()) {
  const alerts = await evaluateAlerts(now);
  const toSend: Alert[] = [];
  for (const a of alerts) {
    const existing = await db.monitoringAlert.findUnique({ where: { key: a.key } });
    const due = !existing?.lastSentAt || now.getTime() - existing.lastSentAt.getTime() >= QUIET_MS[a.severity];
    const details = { kind: a.kind, values: a.values } as Prisma.InputJsonValue;
    await db.monitoringAlert.upsert({
      where: { key: a.key },
      create: { key: a.key, severity: a.severity, summary: a.kind, details, firstSeenAt: now, lastSeenAt: now },
      update: {
        severity: a.severity,
        summary: a.kind,
        details,
        lastSeenAt: now,
        occurrences: { increment: 1 },
      },
    });
    if (due) toSend.push(a);
  }

  let emailed = false;
  if (toSend.length) {
    const ordered = [...toSend].sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "critical" ? -1 : 1));
    try {
      const res = await sendEmail("monitoring-alert", env.ALERTS_EMAIL, {
        alerts: ordered.map((a) => ({ kind: a.kind, severity: a.severity, values: a.values })),
        time: now.toUTCString(),
      });
      emailed = res.success;
      // Marked as sent only once the email went out, so a failed send is retried next run.
      if (emailed) {
        await db.monitoringAlert.updateMany({ where: { key: { in: toSend.map((a) => a.key) } }, data: { lastSentAt: now } });
      }
    } catch (err) {
      log.error({ err: errInfo(err) }, "[alerts] email failed");
    }
  }
  for (const a of alerts) log.warn({ alert: a.key, severity: a.severity, values: a.values }, "monitoring alert");
  return { checkedAt: now.toISOString(), firing: alerts, emailed: emailed ? toSend.map((a) => a.key) : [] };
}

/** Admins only: recent alerts (last seen first) for the admin console. */
export async function listAlerts(limit = 50) {
  const rows = await db.monitoringAlert.findMany({ orderBy: { lastSeenAt: "desc" }, take: Math.min(200, Math.max(1, limit)) });
  return rows.map((r) => ({
    key: r.key,
    severity: r.severity,
    kind: r.summary,
    details: r.details,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
    occurrences: r.occurrences,
  }));
}
