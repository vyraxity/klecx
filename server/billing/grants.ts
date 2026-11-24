import "server-only";
import { log, errInfo } from "@/server/log";
import { db } from "@/server/db/client";
import { PLANS, type PlanKey } from "@/server/billing/plans";
import { resolveSubscriptionPlan, type SubscriptionPlanState } from "@/server/billing/entitlements";
import { grantPlanInTx } from "@/server/services/credits";
import { applyMemberLimitForPlanChange, enforceEndedGrace } from "@/server/services/member-limits";

/**
 * Credit grant lifecycle (Step 8.4). `ensureCurrentGrant(accountId)` runs at
 * the start of `reserve()` and wherever a balance is shown, so every account
 * holds the right allowance for the current period without a cron:
 *
 * - **Free:** one allowance per month, renewed on the person's sign-up date
 *   (the day of the month they signed up, UTC; the 31st becomes the month's
 *   last day). Key `free:<userId>:<period start yyyy-mm-dd>`; verified emails
 *   only. The signup grant counts as the first period.
 * - **Paid monthly:** granted by the `subscription.paid` webhook (Step 8.3).
 *   No lazy grant: the period dates only arrive with webhooks, so a lazy grant
 *   couldn't see a renewal the webhook missed, and would double-grant when the
 *   webhook comes late.
 * - **Paid yearly:** the webhook grants month 0; months 1–11 are granted here,
 *   one plan allowance per month since `currentPeriodStart`
 *   (`yearly:<subscription>:<start>:<n>`).
 * - **Plan ended** (cancel, expiry, refund, dispute, past-due grace over): the
 *   leftover paid credits expire and the Free allowance starts (100 credits,
 *   or 0 when this Free period's credits were already given).
 * - Every grant replaces the plan balance: no rollover. Top-up credits are
 *   never touched. Idempotency keys make repeated calls harmless.
 *
 * It also enforces the collaborator limit once an owner's grace period has
 * ended (F1.3), until the job runner takes that over (Step 10.3).
 */

const SUB_FIELDS = {
  id: true,
  plan: true,
  interval: true,
  status: true,
  providerSubscriptionId: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  lastEventAt: true,
} as const;

type SubState = SubscriptionPlanState & {
  id: string;
  interval: string;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
};

export type GrantState = {
  userId: string;
  /** Sign-up time: Free periods start on its day of the month. */
  signedUpAt: Date;
  emailVerified: boolean;
  deleted: boolean;
  allowancePlan: PlanKey;
  allowanceKey: string | null;
  subscription: SubState | null;
};

export type GrantDecision =
  | { kind: "none" }
  | { kind: "stamp"; key: string }
  | { kind: "free_monthly"; key: string; amount: number }
  | { kind: "yearly_monthly"; key: string; amount: number; plan: PlanKey }
  | { kind: "plan_ended"; freeKey: string; freePeriodStart: Date; previousPlan: PlanKey };

export type GrantResult = {
  action: GrantDecision["kind"];
  /** When the next allowance starts (UI: "Credits reset on …"); null when it depends on a renewal we can't date. */
  resetsAt: Date | null;
};

/** `d` plus `n` calendar months (UTC), the day clamped to the month's end (Jan 31 + 1 → Feb 28/29). */
export function addMonthsUTC(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
  );
}

/** Whole months from `anchor` to `now` (0 before the first month boundary). */
export function monthsSince(anchor: Date, now: Date): number {
  if (now <= anchor) return 0;
  let n = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (n > 0 && addMonthsUTC(anchor, n) > now) n--;
  return n;
}

/** Month of a yearly period that `now` falls in: 0 for the first month … 11. */
export function yearlyMonthIndex(start: Date, now: Date): number {
  return Math.min(11, monthsSince(start, now));
}

/** The Free period `now` falls in: it starts on the sign-up date's day of the month. */
export function freePeriod(signedUpAt: Date, now: Date): { start: Date; next: Date } {
  const n = monthsSince(signedUpAt, now);
  return { start: addMonthsUTC(signedUpAt, n), next: addMonthsUTC(signedUpAt, n + 1) };
}

export function freeGrantKey(userId: string, periodStart: Date): string {
  return `free:${userId}:${periodStart.toISOString().slice(0, 10)}`;
}

export function yearlyGrantKey(sub: Pick<SubState, "id" | "providerSubscriptionId">, start: Date, n: number): string {
  return `yearly:${sub.providerSubscriptionId ?? sub.id}:${start.toISOString().slice(0, 10)}:${n}`;
}

/** What `ensureCurrentGrant` should do, and when the next allowance starts. Pure: no database. */
export function decideGrant(state: GrantState, now: Date): { decision: GrantDecision; resetsAt: Date | null } {
  const sub = state.subscription;
  const effective = resolveSubscriptionPlan(sub, now).plan;

  if (effective === "FREE") {
    const period = freePeriod(state.signedUpAt, now);
    const freeKey = freeGrantKey(state.userId, period.start);
    const resetsAt = period.next;
    if (state.allowancePlan !== "FREE") {
      return {
        decision: { kind: "plan_ended", freeKey, freePeriodStart: period.start, previousPlan: state.allowancePlan },
        resetsAt,
      };
    }
    // Accounts from before Step 8.4 (or created directly): their current balance counts as this month's.
    if (state.allowanceKey === null) return { decision: { kind: "stamp", key: freeKey }, resetsAt };
    if (state.allowanceKey === freeKey || !state.emailVerified || state.deleted) {
      return { decision: { kind: "none" }, resetsAt };
    }
    return { decision: { kind: "free_monthly", key: freeKey, amount: PLANS.FREE.credits }, resetsAt };
  }

  // Paid plan.
  if (!sub) return { decision: { kind: "none" }, resetsAt: null };
  const end = sub.currentPeriodEnd;
  if (sub.interval !== "year" || !sub.currentPeriodStart) {
    return { decision: { kind: "none" }, resetsAt: end && end > now ? end : null };
  }
  const start = sub.currentPeriodStart;
  if (now < start || (end && now >= end)) {
    // Waiting for the renewal (or the past-due grace): the next grant comes with its webhook.
    return { decision: { kind: "none" }, resetsAt: null };
  }
  const n = yearlyMonthIndex(start, now);
  const next = addMonthsUTC(start, n + 1);
  const resetsAt = end && next > end ? end : next;
  if (n === 0) return { decision: { kind: "none" }, resetsAt };
  const key = yearlyGrantKey(sub, start, n);
  if (state.allowanceKey === key) return { decision: { kind: "none" }, resetsAt };
  return { decision: { kind: "yearly_monthly", key, amount: PLANS[effective].credits, plan: effective }, resetsAt };
}

async function loadState(accountId: string) {
  const acc = await db.creditAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      userId: true,
      allowancePlan: true,
      allowanceKey: true,
      user: {
        select: {
          emailVerified: true,
          deletedAt: true,
          createdAt: true,
          subscription: { select: SUB_FIELDS },
          memberLimitGrace: { select: { graceEndsAt: true, enforcedAt: true } },
        },
      },
    },
  });
  if (!acc) return null;
  const state: GrantState = {
    userId: acc.userId,
    signedUpAt: acc.user.createdAt,
    emailVerified: Boolean(acc.user.emailVerified),
    deleted: acc.user.deletedAt !== null,
    allowancePlan: acc.allowancePlan,
    allowanceKey: acc.allowanceKey,
    subscription: acc.user.subscription,
  };
  return { state, grace: acc.user.memberLimitGrace };
}

/**
 * Makes sure the account holds the allowance of the current period (see the
 * file comment). Cheap when nothing is due: one read, no transaction.
 */
export async function ensureCurrentGrant(accountId: string, now: Date = new Date()): Promise<GrantResult> {
  const loaded = await loadState(accountId);
  if (!loaded) return { action: "none", resetsAt: null };
  const { state, grace } = loaded;
  const { decision, resetsAt } = decideGrant(state, now);

  let applied: GrantDecision = { kind: "none" };
  if (decision.kind !== "none") {
    applied = await db.$transaction(async (tx) => {
      // Lock the account and decide again on its current allowance: a concurrent call may have granted it.
      const rows = await tx.$queryRaw<{ allowance_plan: PlanKey; allowance_key: string | null }[]>`
        SELECT allowance_plan, allowance_key FROM credit_accounts WHERE id = ${accountId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return { kind: "none" } as GrantDecision;
      const fresh = decideGrant({ ...state, allowancePlan: row.allowance_plan, allowanceKey: row.allowance_key }, now).decision;

      switch (fresh.kind) {
        case "none":
          return fresh;
        case "stamp":
          await tx.creditAccount.update({ where: { id: accountId }, data: { allowanceKey: fresh.key } });
          return fresh;
        case "free_monthly":
          await grantPlanInTx(tx, accountId, fresh.amount, "free_monthly", fresh.key);
          await tx.creditAccount.update({
            where: { id: accountId },
            data: { allowancePlan: "FREE", allowanceKey: fresh.key },
          });
          return fresh;
        case "yearly_monthly":
          await grantPlanInTx(tx, accountId, fresh.amount, "yearly_monthly", fresh.key);
          await tx.creditAccount.update({
            where: { id: accountId },
            data: { allowancePlan: fresh.plan, allowanceKey: fresh.key },
          });
          return fresh;
        case "plan_ended": {
          // Free credits once per Free period: someone who already had this
          // period's Free allowance before subscribing starts it at 0.
          const freeThisMonth = await tx.creditLedger.findFirst({
            where: {
              accountId,
              type: "GRANT",
              planDelta: { gt: 0 },
              reason: { in: ["monthly_free", "free_monthly"] },
              createdAt: { gte: fresh.freePeriodStart },
            },
            select: { id: true },
          });
          const amount = state.emailVerified && !state.deleted && !freeThisMonth ? PLANS.FREE.credits : 0;
          await grantPlanInTx(
            tx,
            accountId,
            amount,
            amount > 0 ? "free_monthly" : "plan_ended",
            amount > 0 ? fresh.freeKey : `plan_end:${row.allowance_key ?? state.userId}`,
            { expireReason: "plan_ended" }
          );
          await tx.creditAccount.update({
            where: { id: accountId },
            data: { allowancePlan: "FREE", allowanceKey: fresh.freeKey },
          });
          return fresh;
        }
      }
    });
  }

  if (applied.kind === "plan_ended") {
    try {
      await applyMemberLimitForPlanChange(state.userId, applied.previousPlan, "FREE");
    } catch (e) {
      log.error({ grants: "member_limit", err: errInfo(e) });
    }
  }
  if (grace && !grace.enforcedAt && grace.graceEndsAt <= now) {
    try {
      await enforceEndedGrace(state.userId, now);
    } catch (e) {
      log.error({ grants: "enforce_member_limit", err: errInfo(e) });
    }
  }

  return { action: applied.kind, resetsAt };
}

/** `ensureCurrentGrant` for a person (creates nothing when they have no credit account yet). */
export async function ensureCurrentGrantForUser(userId: string, now: Date = new Date()): Promise<GrantResult> {
  const acc = await db.creditAccount.findUnique({ where: { userId }, select: { id: true } });
  if (!acc) return { action: "none", resetsAt: null };
  return ensureCurrentGrant(acc.id, now);
}
