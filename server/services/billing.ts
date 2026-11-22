import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { ApiError, Errors } from "@/server/http/errors";
import { getEntitlements, resolveSubscriptionPlan } from "@/server/billing/entitlements";
import { getBillingProvider } from "@/server/billing/get-provider";
import { BillingProviderError, type BillingProvider } from "@/server/billing/provider";
import { CHECKOUT_SUCCESS_PATH } from "@/lib/billing/links";
import type { CheckoutInput, MySubscription } from "@/lib/schemas/billing";
import { PLANS } from "@/server/billing/plans";
import { planChangeKind } from "@/lib/billing/plan-changes";
import { CHECKOUT_CONSENT_VERSION } from "@/lib/billing/consent";
import { ensureCurrentGrantForUser } from "@/server/billing/grants";
import { addPlanCreditsInTx, ensureCreditAccountInTx } from "@/server/services/credits";
import { applyMemberLimitForPlanChange } from "@/server/services/member-limits";
import { notify } from "@/server/services/notify";

/**
 * Billing actions for the signed-in person (Step 8.2, 8.5): checkout, customer
 * portal, cancel / resume, plan upgrades, and their subscription. Subscription
 * state changes through provider webhooks (Step 8.3), and here only after the
 * provider confirmed the call (cancel, resume, change plan), so the page shows
 * the result at once; the webhook that follows writes the same state.
 */

const billingUnavailable = () =>
  new ApiError(503, "billing_unavailable", "Billing is unavailable right now");

/** Statuses whose provider subscription can still be cancelled. */
const CANCELLABLE = new Set(["ACTIVE", "TRIALING", "PAST_DUE", "PAUSED"]);

function requireProvider(requestId: string, operation: string): BillingProvider {
  const provider = getBillingProvider();
  if (!provider) {
    console.error({ requestId, billing: operation, err: "billing provider not configured" });
    throw billingUnavailable();
  }
  return provider;
}

/** Runs a provider call; a failure is logged with the request id and shown as "billing unavailable". */
async function providerCall<T>(requestId: string, operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BillingProviderError) {
      console.error({
        requestId,
        billing: operation,
        err: e.message,
        status: e.details.status,
        traceId: e.details.traceId,
        cause: e.details.cause,
      });
      throw billingUnavailable();
    }
    throw e;
  }
}

async function loadSubscription(userId: string) {
  return db.subscription.findUnique({
    where: { userId },
    select: {
      id: true,
      currentPeriodStart: true,
      plan: true,
      interval: true,
      status: true,
      providerCustomerId: true,
      providerSubscriptionId: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      lastEventAt: true,
    },
  });
}

/**
 * Creates a hosted checkout for `plan`/`interval` and returns its URL.
 * Someone who still has a paid plan (or a disputed subscription) can't start
 * a second subscription: 409 `subscription_exists`, the UI sends them to the
 * portal / plan change instead. In production checkouts need `BILLING_ENABLED`.
 */
export async function startCheckout(
  userId: string,
  input: CheckoutInput,
  requestId: string
): Promise<{ url: string }> {
  if (env.NODE_ENV === "production" && !env.BILLING_ENABLED) throw billingUnavailable();

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw Errors.unauthorized();

  const sub = await loadSubscription(userId);
  if (sub) {
    const { plan } = resolveSubscriptionPlan(sub);
    if (plan !== "FREE" || sub.status === "DISPUTED") {
      throw Errors.conflict("You already have a subscription", "subscription_exists");
    }
  }

  const provider = requireProvider(requestId, "checkout");
  // Recorded before the provider call: its id comes back on the webhooks as
  // `request_id` and ties the payment to this person (Step 8.3).
  const checkoutRequestId = randomUUID();
  await db.$transaction([
    db.billingCheckout.create({
      data: { id: checkoutRequestId, userId, plan: input.plan, interval: input.interval },
    }),
    db.billingConsent.create({
      data: {
        userId,
        kind: "checkout",
        plan: input.plan,
        interval: input.interval,
        version: CHECKOUT_CONSENT_VERSION,
        checkoutId: checkoutRequestId,
      },
    }),
  ]);
  const { url, checkoutId } = await providerCall(requestId, "checkout", () =>
    provider.createCheckout({
      userId,
      email: user.email,
      customerId: sub?.providerCustomerId ?? null,
      plan: input.plan,
      interval: input.interval,
      requestId: checkoutRequestId,
      successUrl: new URL(CHECKOUT_SUCCESS_PATH, env.APP_URL).toString(),
    })
  );
  await db.billingCheckout.update({
    where: { id: checkoutRequestId },
    data: { providerCheckoutId: checkoutId },
  });
  return { url };
}

/** A link to the provider's customer portal (payment method, invoices, cancel). */
export async function createPortalLink(userId: string, requestId: string): Promise<{ url: string }> {
  const sub = await loadSubscription(userId);
  if (!sub?.providerCustomerId) throw Errors.notFound("Subscription");
  const provider = requireProvider(requestId, "portal");
  return providerCall(requestId, "portal", () => provider.createPortalLink(sub.providerCustomerId!));
}

/**
 * Schedules the cancellation at the end of the paid period. The plan stays
 * until then. Recorded at once (and confirmed by the `subscription.scheduled_cancel`
 * webhook); the person gets the cancellation confirmation (notification + email).
 */
export async function cancelSubscription(userId: string, requestId: string): Promise<{ ok: true }> {
  const sub = await loadSubscription(userId);
  if (!sub?.providerSubscriptionId || !CANCELLABLE.has(sub.status)) {
    throw Errors.notFound("Subscription");
  }
  if (sub.cancelAtPeriodEnd) return { ok: true };
  const provider = requireProvider(requestId, "cancel");
  await providerCall(requestId, "cancel", () =>
    provider.cancelSubscription(sub.providerSubscriptionId!, { atPeriodEnd: true })
  );
  await db.subscription.update({ where: { userId }, data: { cancelAtPeriodEnd: true } });
  await notifySafely(userId, {
    kind: "cancel_scheduled",
    periodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
  }, `billing:cancel_scheduled:${sub.providerSubscriptionId}:${sub.currentPeriodEnd?.toISOString() ?? ""}`);
  return { ok: true };
}

/**
 * Undoes a scheduled cancellation while the paid period still runs (Step 8.5).
 * 409 `nothing_to_resume` when no cancellation is scheduled.
 */
export async function resumeSubscription(userId: string, requestId: string): Promise<{ ok: true }> {
  const sub = await loadSubscription(userId);
  if (!sub?.providerSubscriptionId) throw Errors.notFound("Subscription");
  const periodOver = sub.currentPeriodEnd !== null && sub.currentPeriodEnd <= new Date();
  if (!sub.cancelAtPeriodEnd || periodOver || !["ACTIVE", "TRIALING"].includes(sub.status)) {
    throw Errors.conflict("No cancellation to undo", "nothing_to_resume");
  }
  const provider = requireProvider(requestId, "resume");
  await providerCall(requestId, "resume", () => provider.resumeSubscription(sub.providerSubscriptionId!));
  await db.subscription.update({ where: { userId }, data: { cancelAtPeriodEnd: false } });
  return { ok: true };
}

/**
 * Upgrades the subscription now (Step 8.5): a higher plan, or monthly → yearly.
 * The provider charges the prorated difference; the person gets the
 * difference between the two plans' monthly allowances on top of their
 * balance at once (once per change and period). Downgrades are refused with
 * 422 `plan_change_not_supported` (cancel at period end, then subscribe).
 */
export async function changePlan(
  userId: string,
  input: CheckoutInput,
  requestId: string
): Promise<{ ok: true }> {
  if (env.NODE_ENV === "production" && !env.BILLING_ENABLED) throw billingUnavailable();
  const sub = await loadSubscription(userId);
  if (!sub?.providerSubscriptionId || !["ACTIVE", "TRIALING"].includes(sub.status)) {
    throw Errors.notFound("Subscription");
  }
  if (resolveSubscriptionPlan(sub).plan === "FREE") throw Errors.notFound("Subscription");
  if (sub.cancelAtPeriodEnd) {
    throw Errors.conflict("Resume the subscription before changing plan", "cancel_scheduled");
  }
  const current = { plan: sub.plan, interval: sub.interval === "year" ? ("year" as const) : ("month" as const) };
  const target = { plan: input.plan, interval: input.interval };
  const kind = planChangeKind(current, target);
  if (kind === "same") throw Errors.conflict("This is already your plan", "same_plan");
  if (kind !== "upgrade") {
    throw Errors.unprocessable("Only upgrades can be made here", "plan_change_not_supported");
  }

  const provider = requireProvider(requestId, "change_plan");
  await db.billingConsent.create({
    data: { userId, kind: "plan_change", plan: input.plan, interval: input.interval, version: CHECKOUT_CONSENT_VERSION },
  });
  await providerCall(requestId, "change_plan", () =>
    provider.changeSubscriptionPlan(sub.providerSubscriptionId!, target)
  );

  const extra = Math.max(0, PLANS[input.plan].credits - PLANS[current.plan].credits);
  await db.$transaction(async (tx) => {
    await tx.subscription.update({ where: { userId }, data: { plan: input.plan, interval: input.interval } });
    const account = await ensureCreditAccountInTx(tx, userId);
    if (extra > 0) {
      await addPlanCreditsInTx(
        tx,
        account.id,
        extra,
        "plan_upgrade",
        `upgrade:${sub.providerSubscriptionId}:${current.plan}-${input.plan}:${sub.currentPeriodStart?.toISOString() ?? "now"}`
      );
    }
    await tx.creditAccount.update({ where: { id: account.id }, data: { allowancePlan: input.plan } });
  });

  try {
    await applyMemberLimitForPlanChange(userId, current.plan, input.plan);
  } catch (e) {
    console.error({ requestId, billing: "change_plan_member_limit", err: e instanceof Error ? e.message : "unknown" });
  }
  await notifySafely(userId, { kind: "plan_changed", plan: input.plan }, `billing:plan_changed:${sub.providerSubscriptionId}:${input.plan}:${input.interval}`);
  return { ok: true };
}

async function notifySafely(userId: string, payload: Record<string, unknown>, dedupeKey: string) {
  try {
    await notify(userId, "SUBSCRIPTION_CHANGED", payload, { dedupeKey });
  } catch (e) {
    console.error({ billing: "notify", err: e instanceof Error ? e.message : "unknown" });
  }
}

/**
 * The caller's subscription and effective plan (the same plan as
 * `getEntitlements`), when their credits next reset, and what they can do
 * from the billing page. Provider ids are never sent to the browser.
 */
export async function getMySubscription(userId: string): Promise<MySubscription> {
  const grant = await ensureCurrentGrantForUser(userId).catch(() => null);
  const [sub, entitlements, account] = await Promise.all([
    loadSubscription(userId),
    getEntitlements(userId),
    db.creditAccount.findUnique({ where: { userId }, select: { planBalance: true, topupBalance: true } }),
  ]);
  const resetsAt = grant?.resetsAt?.toISOString() ?? null;
  const balance = (account?.planBalance ?? 0) + (account?.topupBalance ?? 0);
  if (!sub) return { effectivePlan: entitlements.plan, resetsAt, balance, subscription: null };
  const now = new Date();
  const periodOver = sub.currentPeriodEnd !== null && sub.currentPeriodEnd <= now;
  const live = ["ACTIVE", "TRIALING"].includes(sub.status) && entitlements.plan !== "FREE";
  return {
    effectivePlan: entitlements.plan,
    resetsAt,
    balance,
    subscription: {
      plan: sub.plan,
      interval: sub.interval === "year" ? "year" : "month",
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canManage: Boolean(sub.providerCustomerId),
      canCancel: Boolean(sub.providerSubscriptionId) && CANCELLABLE.has(sub.status) && !sub.cancelAtPeriodEnd && !periodOver,
      canResume: Boolean(sub.providerSubscriptionId) && live && sub.cancelAtPeriodEnd && !periodOver,
      canChangePlan: Boolean(sub.providerSubscriptionId) && live && !sub.cancelAtPeriodEnd,
      paymentIssue: sub.status === "PAST_DUE",
    },
  };
}
