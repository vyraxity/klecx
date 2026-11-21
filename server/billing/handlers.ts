import "server-only";
import { PLANS, type PlanKey } from "@/server/billing/plans";
import { resolveSubscriptionPlan, type SubscriptionPlanState } from "@/server/billing/entitlements";
import type {
  BillingInterval,
  BillingProvider,
  NormalizedEvent,
  PaidPlanKey,
  ProviderSubscriptionStatus,
} from "@/server/billing/provider";
import {
  ensureCreditAccountInTx,
  grantPlanInTx,
  refundPlanCreditsInTx,
} from "@/server/services/credits";
import type { Prisma, SubStatus } from "@/server/db/generated/client";
import type { SubscriptionChangeKind } from "@/lib/billing/subscription-changes";

/**
 * Billing webhook state machine (Step 8.3). `applyBillingEvent` runs inside the
 * transaction that also marks the `BillingEvent` row, so the subscription
 * change, the credit grant and the event status commit together or not at all.
 * Anything that leaves the database (notifications, emails, collaborator-limit
 * changes, provider calls) is returned as an `Effect` and run after the commit.
 *
 * Rules:
 * - The person is found by our checkout id (`request_id`), then `metadata.userId`
 *   (set by our server at checkout), then the stored provider subscription /
 *   customer id. Never by email.
 * - Credits are granted only by `subscription.paid`, once per payment (ledger
 *   idempotency key `creem:paid:<transaction id>`).
 * - An event older than `Subscription.lastEventAt` doesn't change the
 *   subscription (out-of-order delivery); a payment it reports is still granted.
 * - DISPUTED stays until support settles the dispute: later provider status
 *   changes don't lift it.
 * - Unknown event types are stored as IGNORED.
 */

type Tx = Prisma.TransactionClient;


export type Effect =
  | { kind: "notify"; userId: string; type: "SUBSCRIPTION_CHANGED"; payload: { kind: SubscriptionChangeKind; periodEnd?: string | null }; dedupeKey: string }
  | { kind: "notify"; userId: string; type: "PAYMENT_FAILED"; payload: Record<string, never>; dedupeKey: string }
  | { kind: "planChanged"; userId: string; before: PlanKey; after: PlanKey }
  | { kind: "cancelNow"; userId: string; subscriptionId: string }
  | { kind: "alert"; reason: string; userId: string | null };

export type EventOutcome = {
  status: "PROCESSED" | "IGNORED";
  userId: string | null;
  /** Short machine-readable note stored in `BillingEvent.error` (why it was ignored). */
  note: string | null;
  effects: Effect[];
};

/** Events this state machine acts on. Everything else is stored as IGNORED. */
export const HANDLED_EVENT_TYPES = [
  "checkout.completed",
  "subscription.active",
  "subscription.trialing",
  "subscription.paid",
  "subscription.update",
  "subscription.paused",
  "subscription.scheduled_cancel",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.unpaid",
  "subscription.expired",
  "refund.created",
  "dispute.created",
] as const;

/** Events that can start a new subscription for someone whose previous one has ended. */
const STARTING_EVENTS = new Set(["checkout.completed", "subscription.active", "subscription.trialing", "subscription.paid"]);

const PROVIDER_STATUS_TO_SUB: Partial<Record<ProviderSubscriptionStatus, SubStatus>> = {
  active: "ACTIVE",
  scheduled_cancel: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  unpaid: "PAST_DUE",
  paused: "PAUSED",
  canceled: "CANCELED",
  expired: "EXPIRED",
};

type SubRow = {
  id: string;
  userId: string;
  plan: PlanKey;
  interval: string;
  status: SubStatus;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  lastEventAt: Date | null;
  lastGrantPeriod: string | null;
};

const ignored = (note: string, userId: string | null = null, effects: Effect[] = []): EventOutcome => ({
  status: "IGNORED",
  userId,
  note,
  effects,
});

const planState = (row: SubRow | null): SubscriptionPlanState | null =>
  row
    ? {
        plan: row.plan,
        status: row.status,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        lastEventAt: row.lastEventAt,
      }
    : null;

/** Ledger idempotency key of the credit grant for one payment. */
export function paidGrantKey(provider: string, transactionId: string): string {
  return `${provider}:paid:${transactionId}`;
}

/** "2026-11" — the month a grant's period starts in (UTC). */
function periodKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

async function resolveUserId(tx: Tx, event: NormalizedEvent): Promise<string | null> {
  const { data } = event;
  if (data.requestId) {
    const checkout = await tx.billingCheckout.findUnique({
      where: { id: data.requestId },
      select: { userId: true },
    });
    if (checkout) return checkout.userId;
  }
  if (data.metadataUserId) {
    const user = await tx.user.findUnique({ where: { id: data.metadataUserId }, select: { id: true } });
    if (user) return user.id;
  }
  if (data.subscription) {
    const sub = await tx.subscription.findUnique({
      where: { providerSubscriptionId: data.subscription.id },
      select: { userId: true },
    });
    if (sub) return sub.userId;
  }
  if (data.customerId) {
    const sub = await tx.subscription.findFirst({
      where: { providerCustomerId: data.customerId },
      select: { userId: true },
    });
    if (sub) return sub.userId;
  }
  return null;
}

/** Plan and interval of the event: product id first, then our checkout metadata, then the stored row. */
function resolvePlan(
  event: NormalizedEvent,
  provider: BillingProvider,
  row: SubRow | null
): { plan: PaidPlanKey; interval: BillingInterval } | null {
  const productId = event.data.subscription?.productId;
  if (productId) {
    const fromProduct = provider.planForProduct(productId);
    if (fromProduct) return fromProduct;
  }
  const { metadataPlan, metadataInterval } = event.data;
  if (
    (metadataPlan === "LITE" || metadataPlan === "STANDARD" || metadataPlan === "PRO") &&
    (metadataInterval === "month" || metadataInterval === "year")
  ) {
    return { plan: metadataPlan, interval: metadataInterval };
  }
  if (row && row.plan !== "FREE") {
    return { plan: row.plan, interval: row.interval === "year" ? "year" : "month" };
  }
  return null;
}

export async function applyBillingEvent(
  tx: Tx,
  event: NormalizedEvent,
  provider: BillingProvider
): Promise<EventOutcome> {
  if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return ignored("unhandled_event_type");
  }

  const resolvedUserId = await resolveUserId(tx, event);
  if (!resolvedUserId) {
    return ignored("user_not_found", null, [{ kind: "alert", reason: "user_not_found", userId: null }]);
  }
  const userId: string = resolvedUserId;

  // One billing event per person at a time: the user row lock serializes them.
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;

  const row = (await tx.subscription.findUnique({ where: { userId } })) as SubRow | null;
  const eventSub = event.data.subscription;
  const effects: Effect[] = [];
  const now = new Date();
  const planBefore = resolveSubscriptionPlan(planState(row), now).plan;

  // Does the event belong to the person's current subscription?
  let replacing = false;
  let otherSubscription = false;
  if (row?.providerSubscriptionId && eventSub && eventSub.id !== row.providerSubscriptionId) {
    const currentEnded = planBefore === "FREE" && row.status !== "DISPUTED";
    if (STARTING_EVENTS.has(event.type) && currentEnded) replacing = true;
    else otherSubscription = true;
  }
  const stale = !replacing && row?.lastEventAt != null && event.createdAt < row.lastEventAt;

  /** Writes subscription fields (and `lastEventAt`) unless the event is stale or about another subscription. */
  async function writeSubscription(
    patch: { status?: SubStatus; cancelAtPeriodEnd?: boolean },
    opts: { createIfMissing: boolean }
  ): Promise<SubRow | null> {
    if (stale || otherSubscription) return row;
    const plan = resolvePlan(event, provider, replacing ? null : row);
    const status: SubStatus | undefined =
      row?.status === "DISPUTED" && !replacing ? undefined : patch.status;
    const common: Prisma.SubscriptionUncheckedUpdateInput = { lastEventAt: event.createdAt };
    if (plan) {
      common.plan = plan.plan;
      common.interval = plan.interval;
    }
    if (eventSub) {
      common.providerSubscriptionId = eventSub.id;
      if (eventSub.currentPeriodStart) common.currentPeriodStart = eventSub.currentPeriodStart;
      if (eventSub.currentPeriodEnd) common.currentPeriodEnd = eventSub.currentPeriodEnd;
    }
    if (event.data.customerId) common.providerCustomerId = event.data.customerId;
    if (patch.cancelAtPeriodEnd !== undefined) common.cancelAtPeriodEnd = patch.cancelAtPeriodEnd;

    if (!row) {
      if (!opts.createIfMissing || !plan || !status) return null;
      return (await tx.subscription.create({
        data: {
          userId,
          status,
          plan: plan.plan,
          interval: plan.interval,
          cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? false,
          providerSubscriptionId: eventSub?.id ?? null,
          providerCustomerId: event.data.customerId,
          currentPeriodStart: eventSub?.currentPeriodStart ?? null,
          currentPeriodEnd: eventSub?.currentPeriodEnd ?? null,
          lastEventAt: event.createdAt,
        },
      })) as SubRow;
    }
    if (replacing) {
      if (!plan || !status) return row;
      return (await tx.subscription.update({
        where: { userId },
        data: {
          ...common,
          status,
          cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? false,
          currentPeriodStart: eventSub?.currentPeriodStart ?? null,
          currentPeriodEnd: eventSub?.currentPeriodEnd ?? null,
          lastGrantPeriod: null,
        },
      })) as SubRow;
    }
    return (await tx.subscription.update({
      where: { userId },
      data: { ...common, ...(status ? { status } : {}) },
    })) as SubRow;
  }

  /** `cancelAtPeriodEnd` as the provider reports it on a live subscription. */
  const providerCancelFlag = (): boolean | undefined =>
    eventSub?.status === "scheduled_cancel" ? true : eventSub?.status === "active" ? false : undefined;

  let after: SubRow | null = row;
  let note: string | null = stale ? "stale_event" : otherSubscription ? "other_subscription" : null;

  switch (event.type) {
    case "checkout.completed": {
      // Stores the customer id; with a subscription, creates/updates the row (no credits).
      if (!eventSub) {
        // One-time products (top-up packs) come later (Step 8.4).
        if (row && event.data.customerId && !row.providerCustomerId) {
          after = (await tx.subscription.update({
            where: { userId },
            data: { providerCustomerId: event.data.customerId },
          })) as SubRow;
        }
        note = note ?? "no_subscription";
        break;
      }
      const isNew = !row || replacing;
      after = await writeSubscription(
        { status: isNew ? "ACTIVE" : undefined, cancelAtPeriodEnd: isNew ? false : undefined },
        { createIfMissing: true }
      );
      if (!after && !row) note = "unknown_product";
      break;
    }

    case "subscription.active":
    case "subscription.trialing":
    case "subscription.update": {
      const status: SubStatus | undefined =
        event.type === "subscription.active"
          ? "ACTIVE"
          : event.type === "subscription.trialing"
            ? "TRIALING"
            : eventSub
              ? PROVIDER_STATUS_TO_SUB[eventSub.status]
              : undefined;
      after = await writeSubscription(
        { status, cancelAtPeriodEnd: providerCancelFlag() },
        { createIfMissing: event.type !== "subscription.update" }
      );
      if (!after && !row) note = "unknown_product";
      break;
    }

    case "subscription.paid": {
      after = await writeSubscription(
        { status: "ACTIVE", cancelAtPeriodEnd: providerCancelFlag() },
        { createIfMissing: true }
      );
      if (otherSubscription || !after) {
        note = after ? "other_subscription" : "unknown_product";
        effects.push({ kind: "alert", reason: `paid_${note}`, userId });
        break;
      }
      const plan = resolvePlan(event, provider, after);
      if (!plan) {
        note = "unknown_product";
        break;
      }
      const transactionId =
        event.data.transaction?.id ??
        `${eventSub?.id ?? "sub"}:${(eventSub?.currentPeriodStart ?? event.createdAt).toISOString()}`;
      const account = await ensureCreditAccountInTx(tx, userId);
      const grant = await grantPlanInTx(
        tx,
        account.id,
        PLANS[plan.plan].credits,
        "subscription.paid",
        paidGrantKey(event.provider, transactionId)
      );
      if (grant.granted) {
        const periodStart = eventSub?.currentPeriodStart ?? event.createdAt;
        if (!stale) {
          after = (await tx.subscription.update({
            where: { userId },
            data: { lastGrantPeriod: periodKey(periodStart) },
          })) as SubRow;
        }
        const firstPayment = !row || replacing || row.lastGrantPeriod === null;
        effects.push({
          kind: "notify",
          userId,
          type: "SUBSCRIPTION_CHANGED",
          payload: { kind: firstPayment ? "activated" : "payment_received" },
          dedupeKey: `billing:paid:${transactionId}`,
        });
      }
      break;
    }

    case "subscription.past_due":
    case "subscription.unpaid": {
      after = await writeSubscription({ status: "PAST_DUE" }, { createIfMissing: false });
      if (after && !stale && !otherSubscription && row?.status !== "PAST_DUE") {
        effects.push({
          kind: "notify",
          userId,
          type: "PAYMENT_FAILED",
          payload: {},
          dedupeKey: `billing:past_due:${eventSub?.id ?? ""}:${eventSub?.currentPeriodEnd?.toISOString() ?? event.id}`,
        });
      }
      break;
    }

    case "subscription.scheduled_cancel": {
      after = await writeSubscription({ cancelAtPeriodEnd: true }, { createIfMissing: false });
      if (after && !stale && !otherSubscription && !row?.cancelAtPeriodEnd) {
        effects.push({
          kind: "notify",
          userId,
          type: "SUBSCRIPTION_CHANGED",
          payload: { kind: "cancel_scheduled", periodEnd: after.currentPeriodEnd?.toISOString() ?? null },
          dedupeKey: `billing:cancel_scheduled:${event.id}`,
        });
      }
      break;
    }

    case "subscription.canceled":
    case "subscription.expired": {
      // A scheduled cancellation keeps `cancelAtPeriodEnd` (plan until the period end);
      // an immediate one (e.g. from the customer portal) ends the plan now.
      const wasEnded = row?.status === "CANCELED" || row?.status === "EXPIRED";
      after = await writeSubscription(
        { status: event.type === "subscription.canceled" ? "CANCELED" : "EXPIRED" },
        { createIfMissing: false }
      );
      if (after && !stale && !otherSubscription && !wasEnded) {
        const stillPaid = resolveSubscriptionPlan(planState(after), now).plan !== "FREE";
        effects.push({
          kind: "notify",
          userId,
          type: "SUBSCRIPTION_CHANGED",
          payload: stillPaid
            ? { kind: "cancel_scheduled", periodEnd: after.currentPeriodEnd?.toISOString() ?? null }
            : { kind: "ended" },
          dedupeKey: `billing:ended:${after.providerSubscriptionId ?? event.id}`,
        });
      }
      break;
    }

    case "subscription.paused": {
      after = await writeSubscription({ status: "PAUSED" }, { createIfMissing: false });
      if (after && !stale && !otherSubscription && row?.status !== "PAUSED") {
        effects.push({
          kind: "notify",
          userId,
          type: "SUBSCRIPTION_CHANGED",
          payload: { kind: "paused" },
          dedupeKey: `billing:paused:${event.id}`,
        });
      }
      break;
    }

    case "refund.created": {
      const refund = event.data.refund;
      const transaction = event.data.transaction;
      if (!refund) {
        note = "malformed_refund";
        break;
      }
      // Full refund: everything paid for that payment has been returned.
      const paid = transaction?.amountPaid ?? null;
      const refunded = Math.max(transaction?.refundedAmount ?? 0, refund.amount ?? 0);
      const full = paid === null || paid <= 0 || refunded >= paid;

      // Credits: only the unused part of that payment's grant, and only while
      // that grant is still the account's current plan allowance.
      const account = await ensureCreditAccountInTx(tx, userId);
      let toRemove = 0;
      let grantFound = false;
      if (transaction) {
        const grant = await tx.creditLedger.findUnique({
          where: { idempotencyKey: paidGrantKey(event.provider, transaction.id) },
          select: { id: true, planDelta: true, createdAt: true },
        });
        if (grant) {
          grantFound = true;
          const newerGrant = await tx.creditLedger.findFirst({
            where: { accountId: account.id, type: "GRANT", planDelta: { gt: 0 }, createdAt: { gt: grant.createdAt } },
            select: { id: true },
          });
          if (!newerGrant) {
            toRemove = full
              ? grant.planDelta
              : Math.floor((grant.planDelta * Math.min(refund.amount ?? 0, paid ?? 0)) / (paid ?? 1));
          }
        }
      }
      await refundPlanCreditsInTx(
        tx,
        account.id,
        toRemove,
        `refund.created:${refund.reason ?? "unspecified"}`,
        `${event.provider}:refund:${refund.id}`
      );

      // A full refund of the current subscription ends the paid plan now (refund policy).
      const ofCurrent = !!row && (!eventSub || eventSub.id === row.providerSubscriptionId);
      if (full && ofCurrent && row) {
        if (row.status !== "DISPUTED") {
          after = (await tx.subscription.update({
            where: { userId },
            data: { status: "CANCELED", cancelAtPeriodEnd: false, lastEventAt: event.createdAt },
          })) as SubRow;
        }
        const liveAtProvider = row.status !== "CANCELED" && row.status !== "EXPIRED";
        if (row.providerSubscriptionId && liveAtProvider) {
          effects.push({ kind: "cancelNow", userId, subscriptionId: row.providerSubscriptionId });
        }
      }
      effects.push({
        kind: "notify",
        userId,
        type: "SUBSCRIPTION_CHANGED",
        payload: { kind: full ? "refunded" : "refunded_partial" },
        dedupeKey: `billing:refund:${refund.id}`,
      });
      // Recorded for support: a refund whose payment granted nothing here.
      note = grantFound ? null : "refund_without_grant";
      break;
    }

    case "dispute.created": {
      // Freezes the account whatever the order of events: `reserve()` refuses while DISPUTED.
      if (row) {
        after = (await tx.subscription.update({
          where: { userId },
          data: { status: "DISPUTED", lastEventAt: stale ? row.lastEventAt : event.createdAt },
        })) as SubRow;
      } else {
        const plan = resolvePlan(event, provider, null);
        after = (await tx.subscription.create({
          data: {
            userId,
            plan: plan?.plan ?? "FREE",
            interval: plan?.interval ?? "month",
            status: "DISPUTED",
            providerSubscriptionId: eventSub?.id ?? null,
            providerCustomerId: event.data.customerId,
            lastEventAt: event.createdAt,
          },
        })) as SubRow;
      }
      effects.push({ kind: "alert", reason: "dispute_created", userId });
      effects.push({
        kind: "notify",
        userId,
        type: "SUBSCRIPTION_CHANGED",
        payload: { kind: "disputed" },
        dedupeKey: `billing:dispute:${event.data.dispute?.id ?? event.id}`,
      });
      note = null;
      break;
    }
  }

  const planAfter = resolveSubscriptionPlan(planState(after), now).plan;
  if (planAfter !== planBefore) {
    effects.push({ kind: "planChanged", userId, before: planBefore, after: planAfter });
  }

  const changed = after !== row || effects.length > 0;
  return {
    status: changed ? "PROCESSED" : "IGNORED",
    userId,
    note: changed ? note : (note ?? "no_change"),
    effects,
  };
}
