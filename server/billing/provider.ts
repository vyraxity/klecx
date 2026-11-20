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
};

export interface BillingProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<{ url: string; checkoutId: string }>;
  createPortalLink(customerId: string): Promise<{ url: string }>;
  cancelSubscription(subscriptionId: string, options: { atPeriodEnd: boolean }): Promise<void>;
  /** Throws `WebhookSignatureError` when the signature is missing or wrong. */
  verifyWebhook(rawBody: string, signature: string | null): NormalizedEvent;
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
