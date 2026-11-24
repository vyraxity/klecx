import "server-only";
import { db } from "@/server/db/client";
import { Errors } from "@/server/http/errors";
import { readCreemEventData } from "@/server/billing/creem";
import {
  PROVIDER_SEARCH_USD,
  SEARCH_SURCHARGE_USD,
  generationCostUsd,
  readUsage,
  searchesOf,
} from "@/server/monitoring/costs";
import { CREDIT_USD } from "@/lib/ai/model-catalog";
import type { Actor } from "@/server/auth/session";

/**
 * Step 10.2 — business metrics for the admin console (`GET /api/v1/admin/metrics`).
 *
 * Everything is computed from the rows themselves (generations, credit
 * ledger, billing events, users), so a number can always be checked by hand.
 * Provider cost = recorded usage × the catalog's prices (`server/monitoring/costs.ts`).
 * Revenue = `amountPaid` of `subscription.paid` events (gross, in USD; Creem's
 * fees and taxes are not taken off), grouped by the payer's current plan.
 * Days are UTC. A range is at most 92 days.
 */

export const MAX_METRICS_DAYS = 92;

type Bucket = Record<string, number>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const add = (b: Bucket, k: string, v = 1) => {
  b[k] = (b[k] ?? 0) + v;
};

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function payloadObject(payload: unknown): unknown {
  return payload && typeof payload === "object" ? (payload as { object?: unknown }).object : undefined;
}

function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t < to.getTime(); t += 86_400_000) {
    out.push(day(new Date(t)));
  }
  return out;
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== "ADMIN") throw Errors.forbidden("Admin role required");
}

export async function getBusinessMetrics(actor: Actor, range: { from: Date; to: Date }) {
  requireAdmin(actor);
  const { from, to } = range;
  if (!(from < to)) throw Errors.badRequest("`from` must be before `to`", "invalid_range");
  if (to.getTime() - from.getTime() > MAX_METRICS_DAYS * 86_400_000) {
    throw Errors.badRequest(`At most ${MAX_METRICS_DAYS} days`, "range_too_long");
  }
  return computeMetrics(from, to);
}

/** The metrics for [from, to). Exported for tests and the alerts. */
export async function computeMetrics(from: Date, to: Date) {
  const inRange = { gte: from, lt: to };
  const [generations, accounts, ledger, billingEvents, newUsers, annotations, notes, limitHits] = await Promise.all([
    db.generation.findMany({
      where: { createdAt: inRange },
      select: {
        kind: true,
        status: true,
        modelKey: true,
        usage: true,
        errorCode: true,
        createdAt: true,
        startedAt: true,
        firstTokenAt: true,
        finishedAt: true,
        billedAccountId: true,
        workspaceId: true,
      },
    }),
    db.creditAccount.findMany({ select: { id: true, userId: true, allowancePlan: true } }),
    db.creditLedger.findMany({
      where: { createdAt: inRange, type: { in: ["RESERVE", "SETTLE", "RELEASE"] } },
      select: { accountId: true, planDelta: true, topupDelta: true },
    }),
    db.billingEvent.findMany({
      where: { receivedAt: { lt: to } },
      select: { type: true, status: true, payload: true, userId: true, receivedAt: true },
      orderBy: { receivedAt: "asc" },
    }),
    db.user.findMany({ where: { createdAt: inRange }, select: { id: true, emailVerified: true } }),
    db.annotation.findMany({ where: { createdAt: inRange, kind: "ASK" }, select: { depth: true } }),
    db.workspaceNote.findMany({ where: { createdAt: inRange }, select: { workspaceId: true } }),
    db.usageLimitHit.findMany({ where: { day: inRange }, select: { kind: true, userId: true, count: true } }),
  ]);

  const planOfAccount = new Map(accounts.map((a) => [a.id, a.allowancePlan as string]));
  const planOfUser = new Map(accounts.map((a) => [a.userId, a.allowancePlan as string]));

  // --- Generations, latency, provider cost -----------------------------------
  const days = daysBetween(from, to);
  const perDay = new Map(days.map((d) => [d, { total: 0, completed: 0, failed: 0, cancelled: 0, providerUsd: 0, revenueUsd: 0 }]));
  const byKind: Record<string, { total: number; completed: number; failed: number; providerUsd: number }> = {};
  const failures: Bucket = {};
  const latency = new Map<string, { ttft: number[]; total: number[] }>();
  const planCost: Bucket = {};
  const searches = { executed: 0, byDay: {} as Bucket };
  const voice = { transcriptionSeconds: 0, transcriptionUsd: 0, readAloudSeconds: 0, readAloudUsd: 0 };
  const reviews = { count: 0, providerUsd: 0 };
  const asksPerWorkspace: Bucket = {};
  let askGenerations = 0;

  for (const g of generations) {
    const d = day(g.createdAt);
    const row = perDay.get(d);
    const k = (byKind[g.kind] ??= { total: 0, completed: 0, failed: 0, providerUsd: 0 });
    k.total++;
    if (row) row.total++;
    if (g.status === "COMPLETED") {
      k.completed++;
      if (row) row.completed++;
    } else if (g.status === "FAILED") {
      k.failed++;
      if (row) row.failed++;
      add(failures, g.errorCode ?? "unknown");
    } else if (g.status === "CANCELLED" && row) row.cancelled++;

    const cost = generationCostUsd(g);
    k.providerUsd += cost;
    if (row) row.providerUsd += cost;
    add(planCost, planOfAccount.get(g.billedAccountId) ?? "UNKNOWN", cost);

    const s = searchesOf(g.usage);
    if (s) {
      searches.executed += s;
      add(searches.byDay, d, s);
    }
    if (g.kind === "TRANSCRIPTION") {
      voice.transcriptionSeconds += Number(readUsage(g.usage).seconds) || 0;
      voice.transcriptionUsd += cost;
    }
    if (g.kind === "SPEECH" && g.status === "COMPLETED") {
      voice.readAloudSeconds += Number(readUsage(g.usage).seconds) || 0;
      voice.readAloudUsd += cost;
    }
    if (g.kind === "DOCUMENT_REVIEW" && g.status === "COMPLETED") {
      reviews.count++;
      reviews.providerUsd += cost;
    }
    if ((g.kind === "ANNOTATION_REPLY" || g.kind === "QUESTION_BATCH") && g.workspaceId) {
      askGenerations++;
      add(asksPerWorkspace, g.workspaceId);
    }
    if (g.status === "COMPLETED" && g.startedAt && g.finishedAt) {
      const l = latency.get(g.modelKey) ?? { ttft: [], total: [] };
      l.total.push(g.finishedAt.getTime() - g.startedAt.getTime());
      if (g.firstTokenAt) l.ttft.push(g.firstTokenAt.getTime() - g.startedAt.getTime());
      latency.set(g.modelKey, l);
    }
  }

  // --- Credits burned per plan (net of each call's reserve/settle/release) ----
  const creditsBurned: Bucket = {};
  for (const l of ledger) add(creditsBurned, planOfAccount.get(l.accountId) ?? "UNKNOWN", -(l.planDelta + l.topupDelta));

  // --- Billing: revenue, refunds, disputes, webhook health --------------------
  const firstPaidTransaction = new Map<string, string>(); // userId → first paid transaction id (all time)
  const revenueByPlan: Bucket = {};
  const payers = new Set<string>();
  let payments = 0;
  let revenueUsd = 0;
  const refunds = { count: 0, amountUsd: 0, firstPurchase: 0, renewal: 0 };
  let disputes = 0;
  let webhookFailed = 0;
  let webhookUnprocessed = 0;

  for (const e of billingEvents) {
    const data = readCreemEventData(e.type, payloadObject(e.payload));
    const inside = e.receivedAt >= from;
    if (e.type === "subscription.paid" && data.transaction && e.userId && !firstPaidTransaction.has(e.userId)) {
      firstPaidTransaction.set(e.userId, data.transaction.id);
    }
    if (!inside) continue;
    if (e.status === "FAILED") webhookFailed++;
    if (e.status === "RECEIVED" && e.receivedAt.getTime() < Date.now() - 10 * 60_000) webhookUnprocessed++;
    if (e.type === "subscription.paid" && data.transaction?.amountPaid) {
      const usd = data.transaction.amountPaid / 100;
      payments++;
      revenueUsd += usd;
      if (e.userId) payers.add(e.userId);
      add(revenueByPlan, (e.userId && planOfUser.get(e.userId)) || "UNKNOWN", usd);
      const row = perDay.get(day(e.receivedAt));
      if (row) row.revenueUsd += usd;
    }
    if (e.type === "refund.created") {
      refunds.count++;
      refunds.amountUsd += (data.refund?.amount ?? 0) / 100;
      const first = e.userId ? firstPaidTransaction.get(e.userId) : undefined;
      if (first && data.transaction?.id === first) refunds.firstPurchase++;
      else refunds.renewal++;
    }
    if (e.type === "dispute.created") disputes++;
  }

  // --- Funnel (people who signed up in the range) -----------------------------
  const newIds = newUsers.map((u) => u.id);
  const [withGeneration, paidEver] = newIds.length
    ? await Promise.all([
        db.generation.findMany({ where: { actorId: { in: newIds } }, select: { actorId: true }, distinct: ["actorId"] }),
        db.billingEvent.findMany({
          where: { userId: { in: newIds }, type: "subscription.paid" },
          select: { userId: true },
          distinct: ["userId"],
        }),
      ])
    : [[], []];

  // --- Shape --------------------------------------------------------------------
  const totalCost = Object.values(planCost).reduce((a, b) => a + b, 0);
  const totalGenerations = generations.length;
  const completed = generations.filter((g) => g.status === "COMPLETED").length;
  const failed = generations.filter((g) => g.status === "FAILED").length;
  const wsCounts = Object.values(asksPerWorkspace);
  const depth: Bucket = {};
  for (const a of annotations) add(depth, String(a.depth));
  const hits: Record<string, { people: number; hits: number }> = {};
  const hitPeople = new Map<string, Set<string>>();
  for (const h of limitHits) {
    (hits[h.kind] ??= { people: 0, hits: 0 }).hits += h.count;
    const set = hitPeople.get(h.kind) ?? new Set();
    set.add(h.userId);
    hitPeople.set(h.kind, set);
  }
  for (const [kind, set] of hitPeople) hits[kind]!.people = set.size;
  const plans = new Set([...Object.keys(planCost), ...Object.keys(revenueByPlan), ...Object.keys(creditsBurned)]);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    generations: {
      total: totalGenerations,
      completed,
      failed,
      successRate: totalGenerations ? round(completed / totalGenerations) : null,
      failuresByCategory: failures,
      byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { ...v, providerUsd: round(v.providerUsd) }])),
    },
    latencyMs: Object.fromEntries(
      [...latency].map(([model, l]) => [
        model,
        {
          count: l.total.length,
          firstTokenP50: percentile(l.ttft, 50),
          firstTokenP95: percentile(l.ttft, 95),
          totalP50: percentile(l.total, 50),
          totalP95: percentile(l.total, 95),
        },
      ])
    ),
    daily: days.map((d) => {
      const r = perDay.get(d)!;
      return { day: d, ...r, providerUsd: round(r.providerUsd), revenueUsd: round(r.revenueUsd, 2) };
    }),
    cost: { providerUsd: round(totalCost), revenueUsd: round(revenueUsd, 2), costToRevenue: revenueUsd > 0 ? round(totalCost / revenueUsd) : null },
    plans: Object.fromEntries(
      [...plans].sort().map((p) => [
        p,
        {
          providerUsd: round(planCost[p] ?? 0),
          revenueUsd: round(revenueByPlan[p] ?? 0, 2),
          creditsBurned: creditsBurned[p] ?? 0,
          creditsBurnedUsd: round((creditsBurned[p] ?? 0) * CREDIT_USD),
        },
      ])
    ),
    searches: {
      executed: searches.executed,
      byDay: searches.byDay,
      surchargeUsd: round(searches.executed * SEARCH_SURCHARGE_USD),
      providerUsd: round(searches.executed * PROVIDER_SEARCH_USD),
    },
    voice: {
      transcriptionSeconds: voice.transcriptionSeconds,
      transcriptionUsd: round(voice.transcriptionUsd),
      readAloudSeconds: voice.readAloudSeconds,
      readAloudUsd: round(voice.readAloudUsd),
    },
    reviews: { count: reviews.count, providerUsd: round(reviews.providerUsd), avgUsd: reviews.count ? round(reviews.providerUsd / reviews.count) : null },
    asks: {
      generations: askGenerations,
      workspaces: wsCounts.length,
      perWorkspaceP50: percentile(wsCounts, 50),
      perWorkspaceMax: wsCounts.length ? Math.max(...wsCounts) : null,
      depthDistribution: depth,
    },
    notes: { created: notes.length, workspaces: new Set(notes.map((n) => n.workspaceId)).size },
    billing: {
      payments,
      payers: payers.size,
      revenueUsd: round(revenueUsd, 2),
      refunds: { ...refunds, amountUsd: round(refunds.amountUsd, 2), rate: payments ? round(refunds.count / payments) : null },
      disputes: { count: disputes, rate: payments ? round(disputes / payments) : null },
      webhooks: { failed: webhookFailed, unprocessed: webhookUnprocessed },
    },
    funnel: {
      signups: newUsers.length,
      verified: newUsers.filter((u) => u.emailVerified).length,
      firstGeneration: withGeneration.length,
      paid: paidEver.length,
    },
    limitHits: hits,
  };
}

export type BusinessMetrics = Awaited<ReturnType<typeof computeMetrics>>;
