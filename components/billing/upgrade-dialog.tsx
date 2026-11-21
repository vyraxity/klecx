"use client";

import * as React from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { gateMessage } from "@/components/ui/gated";
import { ConsentCheckbox } from "@/components/billing/consent-checkbox";
import { useSiteConfig } from "@/components/providers/site-config-provider";
import { INSUFFICIENT_CREDITS_EVENT } from "@/lib/api/client";
import { getApiErrorMessage } from "@/lib/api/error-message";
import { useChangePlan, useMySubscription, useStartCheckout } from "@/lib/api/hooks/billing";
import { PLAN_MANAGE_HREF, PLAN_UPGRADE_HREF } from "@/lib/billing/links";
import { planChangeKind } from "@/lib/billing/plan-changes";
import {
  OPEN_UPGRADE_EVENT,
  isCreditsLow,
  recommendUpgrade,
  type UpgradeReason,
} from "@/lib/billing/upgrade";
import { visiblePlanFeatures } from "@/lib/features/image-generation";
import { PLANS } from "@/server/billing/plans";

/** Remembers that the "credits running low" offer was shown for a credit period (per person and browser). */
function lowCreditsKey(userId: string, resetsAt: string | null) {
  return `klecx-upgrade-low:${userId}:${resetsAt ?? "none"}`;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private mode: the offer may show again, which is harmless.
  }
}

/**
 * Step 8.5: `<UpgradeDialog>` for the signed-in app. Opens when
 * - a request fails with 402 and the person's **own** credits are low (not
 *   when the workspace owner is the one out of credits);
 * - a `<Gated>` tooltip's "Upgrade" is clicked (`openUpgradeDialog(reason)`);
 * - ≥ 80 % of the person's allowance is used (once per credit period).
 * It recommends the cheapest plan that unlocks the thing (`recommendUpgrade`)
 * and never opens while billing is off (rule 9) or when no plan would help.
 */
export function UpgradeDialogHost({ userId }: { userId: string }) {
  const t = useTranslations("UpgradeDialog");
  const tGates = useTranslations("Gates");
  const tRoot = useTranslations();
  const format = useFormatter();
  const { billingEnabled } = useSiteConfig();
  const { data } = useMySubscription(userId, { enabled: billingEnabled && Boolean(userId) });
  const checkout = useStartCheckout();
  const changePlan = useChangePlan(userId);
  const [reason, setReason] = React.useState<UpgradeReason | null>(null);
  const [consent, setConsent] = React.useState(false);

  const currentPlan = data?.effectivePlan ?? "FREE";
  const currentInterval = data?.subscription?.interval ?? "month";
  const recommended = reason ? recommendUpgrade(reason, currentPlan) : null;

  // Listen for requests to open the dialog.
  React.useEffect(() => {
    if (!billingEnabled) return;
    const host = window as { __klecxUpgradeHost?: boolean };
    host.__klecxUpgradeHost = true;
    const onOpen = (e: Event) => setReason((e as CustomEvent<UpgradeReason>).detail);
    window.addEventListener(OPEN_UPGRADE_EVENT, onOpen);
    return () => {
      host.__klecxUpgradeHost = false;
      window.removeEventListener(OPEN_UPGRADE_EVENT, onOpen);
    };
  }, [billingEnabled]);

  // 402: only when the person's own credits are what ran out.
  React.useEffect(() => {
    if (!billingEnabled || !data) return;
    const onOutOfCredits = () => {
      if (isCreditsLow(data.balance, data.effectivePlan)) setReason({ code: "out_of_credits" });
    };
    window.addEventListener(INSUFFICIENT_CREDITS_EVENT, onOutOfCredits);
    return () => window.removeEventListener(INSUFFICIENT_CREDITS_EVENT, onOutOfCredits);
  }, [billingEnabled, data]);

  // ≥ 80 % of the allowance used: offer once per credit period.
  React.useEffect(() => {
    if (!billingEnabled || !data) return;
    if (!isCreditsLow(data.balance, data.effectivePlan)) return;
    if (!recommendUpgrade({ code: "credits_low" }, data.effectivePlan)) return;
    const key = lowCreditsKey(userId, data.resetsAt);
    if (readFlag(key)) return;
    writeFlag(key);
    setReason({ code: "credits_low" });
  }, [billingEnabled, data, userId]);

  if (!billingEnabled || !reason || !recommended) return null;

  const plan = PLANS[recommended];
  const message =
    reason.code === "credits_low"
      ? t("creditsLow", { count: data?.balance ?? 0 })
      : gateMessage(reason, tGates as (k: string, v?: Record<string, string | number>) => string, tRoot);
  const canChangeHere =
    currentPlan !== "FREE" &&
    Boolean(data?.subscription?.canChangePlan) &&
    planChangeKind({ plan: currentPlan, interval: currentInterval }, { plan: recommended, interval: currentInterval }) === "upgrade";
  const pending = checkout.isPending || changePlan.isPending;

  const onUpgrade = () => {
    const target = { plan: recommended, interval: currentInterval, consentImmediateStart: true as const };
    if (currentPlan === "FREE") {
      checkout.mutate(target, {
        onError: (err) => toast.error(getApiErrorMessage(err, tRoot, tRoot("Billing.checkout.failed"))),
      });
      return;
    }
    changePlan.mutate(target, {
      onSuccess: () => {
        setReason(null);
        toast.success(tRoot("Billing.changePlan.done", { plan: tRoot(plan.name) }));
      },
      onError: (err) => toast.error(getApiErrorMessage(err, tRoot, tRoot("Billing.changePlan.failed"))),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          setReason(null);
          setConsent(false);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { plan: tRoot(plan.name) })}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-accent/30 bg-surface-2 p-4 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base font-bold text-fg">{tRoot(plan.name)}</span>
            <span className="text-sm text-fg">
              {tRoot("Billing.pricePerMonth", {
                price: format.number(plan.priceMonthly, { style: "currency", currency: "USD" }),
              })}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5 text-xs">
            {visiblePlanFeatures(plan.features).map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-fg/90">
                <Check className="h-3.5 w-3.5 text-accent shrink-0 mt-0.5" />
                <span>{tRoot(feature)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted">{tRoot("Billing.taxNote")}</p>
        </div>

        {(currentPlan === "FREE" || canChangeHere) && (
          <ConsentCheckbox id="upgrade-dialog-consent" checked={consent} onCheckedChange={setConsent} />
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={PLAN_UPGRADE_HREF} onClick={() => setReason(null)}>
              {t("seePlans")}
            </Link>
          </Button>
          {currentPlan === "FREE" || canChangeHere ? (
            <Button size="sm" disabled={pending || !consent} onClick={onUpgrade}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t("upgradeTo", { plan: tRoot(plan.name) })}
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link href={PLAN_MANAGE_HREF} onClick={() => setReason(null)}>
                {t("manage")}
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
