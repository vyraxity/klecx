import "server-only";
import type { PlanKey } from "@/server/billing/plans";

/**
 * Billing provider interface (Step 8.2). Everything outside `server/billing/`
 * talks to this, never to Creem directly, so a provider change means writing
 * one new adapter (guide §4.2).
 */

/** Plans that can be bought. FREE has no product. */
export type PaidPlanKey = Exclude<PlanKey, "FREE">;
export const PAID_PLANS = ["LITE", "STANDARD", "PRO"] as const satisfies readonly PaidPlanKey[];

export type BillingInterval = "month" | "year";
export const BILLING_INTERVALS = ["month", "year"] as const satisfies readonly BillingInterval[];

export type CreateCheckoutInput = {
  userId: string;
  /** Prefills the checkout. Ignored when `customerId` is given (the provider takes one or the other). */
  email: string;
  /** The provider's customer id from an earlier subscription, so a returning buyer keeps one customer. */
  customerId?: string | null;
  plan: PaidPlanKey;
  interval: BillingInterval;
  /** Our id for this checkout; sent to the provider and returned on its webhooks. */
  requestId: string;
  successUrl: string;
};

/** Subscription status as the provider reports it, mapped to our words. */
export type ProviderSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "paused"
  | "scheduled_cancel"
  | "canceled"
  | "expired"
  | "unknown";

/**
 * The fields of a webhook event the state machine (Step 8.3) needs, read out
 * of the provider's payload by the adapter. Every field is optional: which
 * ones are present depends on the event type.
 */
export type BillingEventData = {
  /** Our checkout id (`request_id`), when the event carries it. */
  requestId: string | null;
  /** `metadata.userId` we set at checkout. Set by our server and signed, never typed by the buyer. */
  metadataUserId: string | null;
  /** Plan / interval from our checkout metadata (a fallback; the product id decides first). */
  metadataPlan: string | null;
  metadataInterval: string | null;
  customerId: string | null;
  subscription: {
    id: string;
    status: ProviderSubscriptionStatus;
    productId: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    canceledAt: Date | null;
  } | null;
  /** The payment the event is about (`subscription.paid`: the renewal; refunds and disputes: the refunded/disputed one). */
  transaction: {
    id: string;
    /** Amount actually paid, in minor units. */
    amountPaid: number | null;
    /** Total refunded so far on this payment, in minor units. */
    refundedAmount: number | null;
  } | null;
  refund: { id: string; amount: number | null; reason: string | null } | null;
  dispute: { id: string } | null;
};

/** A verified webhook event, before the state machine (Step 8.3) reads it. */
export type NormalizedEvent = {
  provider: string;
  /** Provider event id (`evt_…`), unique per event; retries keep it. */
  id: string;
  /** Provider event type, e.g. `subscription.paid`. */
  type: string;
  createdAt: Date;
  /** The event's object (checkout, subscription, refund…), as sent. */
  object: unknown;
  /** The whole parsed payload, for `BillingEvent.payload`. */
  payload: unknown;
  data: BillingEventData;
};

export interface BillingProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<{ url: string; checkoutId: string }>;
  createPortalLink(customerId: string): Promise<{ url: string }>;
  cancelSubscription(subscriptionId: string, options: { atPeriodEnd: boolean }): Promise<void>;
  /** Undoes a scheduled cancellation (Step 8.5). */
  resumeSubscription(subscriptionId: string): Promise<void>;
  /** Moves the subscription to another plan / interval now, charging the prorated difference (Step 8.5). */
  changeSubscriptionPlan(
    subscriptionId: string,
    target: { plan: PaidPlanKey; interval: BillingInterval }
  ): Promise<void>;
  /**
   * Step 10.3 (`reconcile-billing`): the subscription as the provider has it
   * now, read with the same parser as the webhooks; null when it doesn't exist.
   */
  getSubscription(subscriptionId: string): Promise<BillingEventData["subscription"]>;
  /** Throws `WebhookSignatureError` when the signature is missing or wrong. */
  verifyWebhook(rawBody: string, signature: string | null): NormalizedEvent;
  /** Product id → the plan and interval it sells; null for a product we don't know. */
  planForProduct(productId: string): { plan: PaidPlanKey; interval: BillingInterval } | null;
}

/** The provider is not configured, or a call to it failed. Details are logged, never shown. */
export class BillingProviderError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
    public readonly details: { status?: number; traceId?: string; cause?: string } = {}
  ) {
    super(message);
    this.name = "BillingProviderError";
  }
}

export class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}
