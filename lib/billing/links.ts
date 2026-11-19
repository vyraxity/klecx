/**
 * Where plan upgrades and plan management point (Step 8.1). Only shown while
 * billing is on (`useSiteConfig().billingEnabled`, rule 9).
 * TODO(8.5): point PLAN_MANAGE_HREF at the billing section of Settings once it exists.
 */
export const PLAN_UPGRADE_HREF = "/pricing";
export const PLAN_MANAGE_HREF = "/pricing";

/**
 * Where the provider's checkout sends the buyer back (Step 8.2). The redirect
 * proves nothing; the page polls `GET /api/v1/me/subscription` until the
 * webhook (Step 8.3) activates the plan.
 * TODO(8.5): the billing section of Settings.
 */
export const CHECKOUT_SUCCESS_PATH = "/settings?checkout=success";
