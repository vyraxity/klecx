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

export type MySubscription = {
  /** The plan the person may use now (`resolveSubscriptionPlan`). */
  effectivePlan: "FREE" | "LITE" | "STANDARD" | "PRO";
  subscription: {
    plan: "FREE" | "LITE" | "STANDARD" | "PRO";
    interval: "month" | "year";
    status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "PAUSED" | "CANCELED" | "EXPIRED" | "DISPUTED";
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    /** Whether "Manage billing" (the provider's customer portal) can be opened. */
    canManage: boolean;
  } | null;
};
