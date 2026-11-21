import { PLAN_ORDER, type GateReason } from "@/lib/entitlements/shared";
import { PLANS, type PlanKey } from "@/server/billing/plans";
import type { PaidPlan } from "@/lib/billing/plan-changes";

/**
 * Step 8.5: which plan the upgrade dialog recommends — the **cheapest** plan
 * above the person's own that unlocks what they hit. Reasons the person can't
 * fix by upgrading their own plan (the workspace owner's plan or credits, a
 * permission, a browser) recommend nothing, and the dialog doesn't open.
 */
export type UpgradeReason = GateReason | { code: "credits_low" };

const above = (current: PlanKey) => PLAN_ORDER.slice(PLAN_ORDER.indexOf(current) + 1) as PaidPlan[];

export function recommendUpgrade(reason: UpgradeReason, current: PlanKey): PaidPlan | null {
  const candidates = above(current);
  switch (reason.code) {
    case "requires_plan":
      return reason.plan !== "FREE" && candidates.includes(reason.plan as PaidPlan) ? (reason.plan as PaidPlan) : null;
    case "member_limit":
      return candidates.find((p) => PLANS[p].limits.members > reason.limit) ?? null;
    case "attachment_limit":
      return candidates.find((p) => PLANS[p].limits.attachmentsPerWorkspace > reason.limit) ?? null;
    case "out_of_credits":
    case "credits_low":
    case "daily_cap":
      return candidates.find((p) => PLANS[p].credits > PLANS[current].credits) ?? null;
    default:
      return null;
  }
}

/** Share of the plan allowance left at which the dialog offers an upgrade (≥ 80 % used). */
export const CREDITS_LOW_SHARE = 0.2;

export function isCreditsLow(balance: number, plan: PlanKey): boolean {
  const allowance = PLANS[plan]?.credits ?? 0;
  return allowance > 0 && balance <= allowance * CREDITS_LOW_SHARE;
}

/** Window event that opens the upgrade dialog (`openUpgradeDialog`). */
export const OPEN_UPGRADE_EVENT = "klecx:open-upgrade";

/** Opens the upgrade dialog when the app shell hosts it; returns false when nothing listens (e.g. marketing pages). */
export function openUpgradeDialog(reason: UpgradeReason): boolean {
  if (typeof window === "undefined" || !(window as { __klecxUpgradeHost?: boolean }).__klecxUpgradeHost) return false;
  window.dispatchEvent(new CustomEvent<UpgradeReason>(OPEN_UPGRADE_EVENT, { detail: reason }));
  return true;
}
