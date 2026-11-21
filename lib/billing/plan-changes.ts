import { PLAN_ORDER } from "@/lib/entitlements/shared";
import type { PlanKey } from "@/server/billing/plans";

/**
 * Which self-service plan changes exist (Step 8.5), shared by the server
 * (which enforces it) and the billing page (which offers only these).
 *
 * Only **upgrades** take effect from Klecx: a higher plan (same or longer
 * billing period), or the same plan from monthly to yearly. They apply at once
 * and the provider charges the prorated difference. Downgrades and yearly →
 * monthly would refund unused time at the provider while credits were already
 * spent, so they go through "cancel at period end, then subscribe to the new
 * plan" (OPEN_DECISIONS.md §9).
 */
export type PaidPlan = Exclude<PlanKey, "FREE">;
export type Interval = "month" | "year";
export type PlanChangeKind = "upgrade" | "same" | "not_supported";

const rank = (plan: PlanKey) => PLAN_ORDER.indexOf(plan);

export function planChangeKind(
  current: { plan: PlanKey; interval: Interval },
  target: { plan: PaidPlan; interval: Interval }
): PlanChangeKind {
  if (current.plan === target.plan && current.interval === target.interval) return "same";
  if (current.interval === "year" && target.interval === "month") return "not_supported";
  if (rank(target.plan) > rank(current.plan)) return "upgrade";
  if (target.plan === current.plan && current.interval === "month" && target.interval === "year") return "upgrade";
  return "not_supported";
}

/** Every upgrade available from `current`, cheapest first. */
export function upgradeOptions(current: { plan: PlanKey; interval: Interval }): Array<{ plan: PaidPlan; interval: Interval }> {
  const out: Array<{ plan: PaidPlan; interval: Interval }> = [];
  for (const plan of PLAN_ORDER) {
    if (plan === "FREE") continue;
    for (const interval of ["month", "year"] as const) {
      if (planChangeKind(current, { plan, interval }) === "upgrade") out.push({ plan, interval });
    }
  }
  return out;
}
