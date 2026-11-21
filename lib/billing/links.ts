/**
 * Where plan upgrades and plan management point (Step 8.1, 8.5). Only shown
 * while billing is on (`useSiteConfig().billingEnabled`, rule 9).
 */
export const PLAN_UPGRADE_HREF = "/pricing";
export const PLAN_MANAGE_HREF = "/settings/billing";

/**
 * Where the provider's checkout sends the buyer back (Step 8.2, 8.5). The
 * redirect proves nothing; the billing page polls `GET /api/v1/me/subscription`
 * until the webhook (Step 8.3) activates the plan.
 */
export const CHECKOUT_SUCCESS_PATH = "/settings/billing?checkout=success";

/** The refund policy section of the Terms (Step 8.5: linked from the billing page). */
export const REFUND_POLICY_HREF = "/terms#subscriptions";
