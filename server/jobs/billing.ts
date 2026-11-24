import "server-only";
import { db } from "@/server/db/client";
import { log, errInfo } from "@/server/log";
import { ensureCurrentGrant } from "@/server/billing/grants";
import { enforceEndedGrace } from "@/server/services/member-limits";
import { getBillingProvider } from "@/server/billing/get-provider";
import type { ProviderSubscriptionStatus } from "@/server/billing/provider";
import type { SubStatus } from "@/server/db/generated/client";
import type { JobResult } from "./runner";

/** Stop starting new items after this long, so a run ends well inside the 300 s limit. */
const TIME_BUDGET_MS = 200_000;

/**
 * `refresh-credit-periods` (daily, from Step 8.4): `ensureCurrentGrant()` for
 * every account whose allowance is a paid plan's. It expires the credits of
 * plans that ended (cancelled, expired, refunded, past-due grace over) and
 * gives yearly subscribers their monthly allowance, even for people who never
 * come back (the lazy call at their next request stays as a safety net).
 * Free accounts renew lazily: their balance is only seen when they use it.
 */
export async function refreshCreditPeriods(
  now: Date = new Date(),
  opts: { userIds?: string[] } = {}
): Promise<JobResult> {
  const deadline = Date.now() + TIME_BUDGET_MS;
  let cursor: string | undefined;
  let checked = 0;
  let changed = 0;
  let failed = 0;
  let more = false;
  for (;;) {
    const accounts = await db.creditAccount.findMany({
      where: { allowancePlan: { not: "FREE" }, ...(opts.userIds ? { userId: { in: opts.userIds } } : {}) },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (accounts.length === 0) break;
    for (const a of accounts) {
      if (Date.now() > deadline) {
        more = true;
        break;
      }
      checked++;
      try {
        const res = await ensureCurrentGrant(a.id, now);
        if (res.action !== "none") changed++;
      } catch (err) {
        failed++;
        log.error({ job: "refresh-credit-periods", err: errInfo(err) }, "grant check failed");
      }
    }
    if (more || accounts.length < 200) break;
    cursor = accounts[accounts.length - 1]!.id;
  }
  return { checked, changed, failed, more };
}

/**
 * `enforce-member-limits` (daily, F1.3 / Step 8.4): owners whose 14-day
 * over-limit grace has ended get their extra collaborators suspended (and
 * told), even if the owner never comes back. `enforceEndedGrace()` claims the
 * grace row first, so this never suspends or notifies twice.
 */
export async function enforceMemberLimits(now: Date = new Date()): Promise<JobResult> {
  const due = await db.memberLimitGrace.findMany({
    where: { enforcedAt: null, graceEndsAt: { lte: now } },
    select: { ownerId: true },
    orderBy: { graceEndsAt: "asc" },
    take: 100,
  });
  let enforced = 0;
  let failed = 0;
  for (const g of due) {
    try {
      if (await enforceEndedGrace(g.ownerId, now)) enforced++;
    } catch (err) {
      failed++;
      log.error({ job: "enforce-member-limits", err: errInfo(err) }, "enforce failed");
    }
  }
  return { due: due.length, enforced, failed, more: due.length === 100 };
}

/** What our row should say for a provider status (as the webhook state machine maps it). */
const PROVIDER_TO_LOCAL: Partial<Record<ProviderSubscriptionStatus, SubStatus>> = {
  active: "ACTIVE",
  scheduled_cancel: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  unpaid: "PAST_DUE",
  paused: "PAUSED",
  canceled: "CANCELED",
  expired: "EXPIRED",
};

/** Period ends further apart than this count as drift (time zones, clock skew). */
const PERIOD_TOLERANCE_MS = 36 * 60 * 60_000;

/**
 * `reconcile-billing` (daily): compares every live subscription (ACTIVE,
 * TRIALING, PAST_DUE) with what the provider says now, to catch missed
 * webhooks. **Detect only**: a drift is logged (our subscription id, both
 * statuses, never the person) and counted; the `billing_drift` alert emails
 * it and an admin resolves it (`ADMIN_CONSOLE.md` §23), because applying a
 * guessed state could grant or remove credits wrongly. DISPUTED rows are
 * skipped (an admin owns them). Does nothing while billing isn't configured.
 */
export async function reconcileBilling(opts: { userIds?: string[] } = {}): Promise<JobResult> {
  const provider = getBillingProvider();
  if (!provider) return { configured: false };
  const deadline = Date.now() + TIME_BUDGET_MS;
  const subs = await db.subscription.findMany({
    where: {
      status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
      providerSubscriptionId: { not: null },
      ...(opts.userIds ? { userId: { in: opts.userIds } } : {}),
    },
    select: { id: true, status: true, cancelAtPeriodEnd: true, currentPeriodEnd: true, providerSubscriptionId: true },
    orderBy: { updatedAt: "asc" },
    take: 500,
  });
  let checked = 0;
  let drift = 0;
  let failed = 0;
  let more = false;
  for (const sub of subs) {
    if (Date.now() > deadline) {
      more = true;
      break;
    }
    checked++;
    try {
      const remote = await provider.getSubscription(sub.providerSubscriptionId!);
      const reasons: string[] = [];
      if (!remote) {
        reasons.push("missing_at_provider");
      } else {
        const expected = PROVIDER_TO_LOCAL[remote.status];
        if (expected && expected !== sub.status) reasons.push("status");
        if (remote.status === "scheduled_cancel" && !sub.cancelAtPeriodEnd) reasons.push("scheduled_cancel");
        if (remote.status === "active" && sub.cancelAtPeriodEnd) reasons.push("cancel_flag");
        if (
          remote.currentPeriodEnd &&
          sub.currentPeriodEnd &&
          Math.abs(remote.currentPeriodEnd.getTime() - sub.currentPeriodEnd.getTime()) > PERIOD_TOLERANCE_MS
        ) {
          reasons.push("period_end");
        }
      }
      if (reasons.length > 0) {
        drift++;
        log.warn(
          { job: "reconcile-billing", subscriptionId: sub.id, local: sub.status, remote: remote?.status ?? null, reasons },
          "billing drift"
        );
      }
    } catch (err) {
      failed++;
      log.error({ job: "reconcile-billing", err: errInfo(err) }, "provider lookup failed");
    }
  }
  return { configured: true, checked, drift, failed, more: more || subs.length === 500 };
}
