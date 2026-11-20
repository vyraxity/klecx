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

/**
 * Billing actions for the signed-in person (Step 8.2): checkout, customer
 * portal, cancellation, and their subscription. Subscription state only
 * changes through provider webhooks (Step 8.3), never here.
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
  const checkoutRequestId = randomUUID();
  const { url } = await providerCall(requestId, "checkout", () =>
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
 * until then; the `subscription.scheduled_cancel` webhook (Step 8.3) records it.
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
  return { ok: true };
}

/**
 * The caller's subscription and effective plan (the same plan as
 * `getEntitlements`). Provider ids are never sent to the browser.
 */
export async function getMySubscription(userId: string): Promise<MySubscription> {
  const [sub, entitlements] = await Promise.all([loadSubscription(userId), getEntitlements(userId)]);
  if (!sub) return { effectivePlan: entitlements.plan, subscription: null };
  return {
    effectivePlan: entitlements.plan,
    subscription: {
      plan: sub.plan,
      interval: sub.interval === "year" ? "year" : "month",
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canManage: Boolean(sub.providerCustomerId),
    },
  };
}
