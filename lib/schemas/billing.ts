import { z } from "zod";

/**
 * Billing requests (Step 8.2). The client names a plan and a billing period,
 * never a product id or a price: the server maps them to the provider's product.
 */
export const checkoutSchema = z
  .object({
    plan: z.enum(["LITE", "STANDARD", "PRO"]),
    interval: z.enum(["month", "year"]),
  })
  .strict();
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/**
 * Cancelling from Klecx always takes effect at the end of the paid period.
 * An immediate cancellation (with a refund) goes through support (refund policy).
 */
export const cancelSubscriptionSchema = z
  .object({
    atPeriodEnd: z.literal(true),
  })
  .strict();

/** Step 8.5: a plan upgrade names the target plan and billing period, like a checkout. */
export const changePlanSchema = checkoutSchema;

export type MySubscription = {
  /** The plan the person may use now (`resolveSubscriptionPlan`). */
  effectivePlan: "FREE" | "LITE" | "STANDARD" | "PRO";
  /** When the next credit allowance starts (Step 8.4); null when it waits for a renewal. */
  resetsAt: string | null;
  /** The person's own credit balance (plan + top-up), for the upgrade dialog (Step 8.5). */
  balance: number;
  subscription: {
    plan: "FREE" | "LITE" | "STANDARD" | "PRO";
    interval: "month" | "year";
    status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "PAUSED" | "CANCELED" | "EXPIRED" | "DISPUTED";
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    /** Whether "Manage billing" (the provider's customer portal) can be opened. */
    canManage: boolean;
    /** Step 8.5: which billing-page actions apply now. */
    canCancel: boolean;
    canResume: boolean;
    canChangePlan: boolean;
    /** A renewal payment failed (PAST_DUE): show the "update your payment method" banner. */
    paymentIssue: boolean;
  } | null;
};
