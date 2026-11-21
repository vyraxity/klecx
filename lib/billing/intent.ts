import type { Interval, PaidPlan } from "@/lib/billing/plan-changes";

/**
 * Step 8.5: the plan someone picked on the pricing page before signing up
 * (`?subscribe=lite&interval=year`), carried through sign-up and email
 * verification to Settings → Billing, which offers to continue to checkout.
 * Only names a plan and a period; the server still decides the product and price.
 */
export function parseSubscribeIntent(
  plan: string | null | undefined,
  interval: string | null | undefined
): { plan: PaidPlan; interval: Interval } | null {
  const p = plan?.toUpperCase();
  if (p !== "LITE" && p !== "STANDARD" && p !== "PRO") return null;
  return { plan: p, interval: interval === "year" ? "year" : "month" };
}

/** Where to land after sign-up for a chosen plan. */
export function subscribeIntentPath(plan: PaidPlan, interval: Interval): string {
  return `/settings/billing?subscribe=${plan.toLowerCase()}&interval=${interval}`;
}

/** `?plan=lite&interval=year`, to carry the choice between the auth pages. Empty without a choice. */
export function subscribeIntentQuery(intent: { plan: PaidPlan; interval: Interval } | null): string {
  return intent ? `?plan=${intent.plan.toLowerCase()}&interval=${intent.interval}` : "";
}
