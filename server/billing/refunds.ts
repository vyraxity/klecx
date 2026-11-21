import "server-only";
import { db } from "@/server/db/client";
import { Errors } from "@/server/http/errors";

/**
 * Refund eligibility under the refund policy (interlude §2.8, Step 8.4), for
 * support: computed from the credit ledger, never from what the customer says.
 *
 * - `first_purchase_14d`: the customer's **first** payment, asked within 14
 *   days, < 20 % of that payment's credits used, no earlier refund (once per customer).
 * - `renewal_7d`: a renewal, asked within 7 days, no credits used since it.
 * - `error`: a second payment within 24 h of the previous one (a likely
 *   duplicate charge): always refunded. Other billing errors and outages are
 *   judged by support.
 *
 * "The payment" is the latest one (the latest `subscription.paid` grant).
 * Credits used = plan credits spent (reservations, settlements, releases)
 * between that grant and the next allowance. Top-up credits don't count.
 */

export type RefundRule = "first_purchase_14d" | "renewal_7d" | "error";

export type RefundEligibility = {
  eligible: boolean;
  /** The rule the latest payment falls under; null when there is no payment. */
  rule: RefundRule | null;
  creditsUsedPct: number | null;
  daysSincePayment: number | null;
  /** 1 = first payment ever on this account. 0 = none. */
  paymentNumber: number;
  previousRefunds: number;
  paidAt: Date | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const FIRST_PURCHASE_DAYS = 14;
export const FIRST_PURCHASE_MAX_USED_PCT = 20;
export const RENEWAL_DAYS = 7;
const DUPLICATE_WINDOW_MS = DAY_MS;

const SPENDING_TYPES = ["RESERVE", "SETTLE", "RELEASE"] as const;

/** `subscriptionId` is our `Subscription.id`. */
export async function getRefundEligibility(subscriptionId: string, now: Date = new Date()): Promise<RefundEligibility> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId }, select: { userId: true } });
  if (!sub) throw Errors.notFound("Subscription");

  const none: RefundEligibility = {
    eligible: false,
    rule: null,
    creditsUsedPct: null,
    daysSincePayment: null,
    paymentNumber: 0,
    previousRefunds: 0,
    paidAt: null,
  };
  const account = await db.creditAccount.findUnique({ where: { userId: sub.userId }, select: { id: true } });
  if (!account) return none;

  const [payments, refunds] = await Promise.all([
    db.creditLedger.findMany({
      where: { accountId: account.id, type: "GRANT", reason: "subscription.paid", idempotencyKey: { contains: ":paid:" } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, planDelta: true },
    }),
    db.creditLedger.count({ where: { accountId: account.id, type: "REFUND" } }),
  ]);
  const latest = payments.at(-1);
  if (!latest) return { ...none, previousRefunds: refunds };

  const nextGrant = await db.creditLedger.findFirst({
    where: { accountId: account.id, type: "GRANT", planDelta: { gt: 0 }, createdAt: { gt: latest.createdAt } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const spent = await db.creditLedger.aggregate({
    where: {
      accountId: account.id,
      type: { in: [...SPENDING_TYPES] },
      createdAt: { gte: latest.createdAt, ...(nextGrant ? { lt: nextGrant.createdAt } : {}) },
    },
    _sum: { planDelta: true },
  });
  const used = Math.max(0, -(spent._sum.planDelta ?? 0));
  const creditsUsedPct = latest.planDelta > 0 ? Math.round((used / latest.planDelta) * 1000) / 10 : used > 0 ? 100 : 0;
  const daysSincePayment = Math.floor((now.getTime() - latest.createdAt.getTime()) / DAY_MS);
  const paymentNumber = payments.length;
  const base = { creditsUsedPct, daysSincePayment, paymentNumber, previousRefunds: refunds, paidAt: latest.createdAt };

  const previous = payments.at(-2);
  if (previous && latest.createdAt.getTime() - previous.createdAt.getTime() < DUPLICATE_WINDOW_MS) {
    return { ...base, eligible: true, rule: "error" };
  }
  if (paymentNumber === 1) {
    return {
      ...base,
      rule: "first_purchase_14d",
      eligible: daysSincePayment < FIRST_PURCHASE_DAYS && creditsUsedPct < FIRST_PURCHASE_MAX_USED_PCT && refunds === 0,
    };
  }
  return { ...base, rule: "renewal_7d", eligible: daysSincePayment < RENEWAL_DAYS && used === 0 };
}

/** The eligibility of `userId`'s subscription, or null without one (support tickets). */
export async function getRefundEligibilityForUser(userId: string, now: Date = new Date()): Promise<RefundEligibility | null> {
  const sub = await db.subscription.findUnique({ where: { userId }, select: { id: true } });
  return sub ? getRefundEligibility(sub.id, now) : null;
}
