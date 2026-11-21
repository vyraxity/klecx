"use client";

import * as React from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Interval, PaidPlan } from "@/lib/billing/plan-changes";
import { PLANS, type PlanKey } from "@/server/billing/plans";

export interface PlanPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The paid plan the person has now; null on Free (then every plan is offered and checkout starts). */
  current: { plan: PlanKey; interval: Interval } | null;
  /** The plans that may be picked (`upgradeOptions`). */
  options: Array<{ plan: PaidPlan; interval: Interval }>;
  pending: boolean;
  onPick: (target: { plan: PaidPlan; interval: Interval }) => void;
}

/**
 * Step 8.5: choose a paid plan, from Free (checkout) or as an upgrade. Prices
 * and credits come from `PLANS`; the server maps the choice to a product.
 */
export function PlanPicker({ open, onOpenChange, current, options, pending, onPick }: PlanPickerProps) {
  const t = useTranslations("Billing");
  const tRoot = useTranslations();
  const format = useFormatter();
  const intervals = (["month", "year"] as const).filter((iv) => options.some((o) => o.interval === iv));
  // Opens on the person's own billing period when it has options, else the first one.
  const preferred: Interval = current?.interval ?? "month";
  const [interval, setInterval] = React.useState<Interval>(
    intervals.includes(preferred) ? preferred : (intervals[0] ?? "month")
  );
  const shown = options.filter((o) => o.interval === interval);
  const [picked, setPicked] = React.useState<string | null>(null);

  const price = (plan: PaidPlan, iv: Interval) =>
    format.number(iv === "year" ? PLANS[plan].priceYearly : PLANS[plan].priceMonthly, { style: "currency", currency: "USD" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{current ? t("changePlan.title") : t("upgradeTitle")}</DialogTitle>
          <DialogDescription>
            {current ? t("changePlan.description") : t("upgradeDescription")}
          </DialogDescription>
        </DialogHeader>

        {intervals.length > 1 && (
          <div className="inline-flex self-start rounded-xl border border-border bg-surface-2 p-1" role="tablist" aria-label={t("intervalLabel")}>
            {intervals.map((iv) => (
              <button
                key={iv}
                type="button"
                role="tab"
                aria-selected={interval === iv}
                onClick={() => setInterval(iv)}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer",
                  interval === iv ? "bg-surface text-fg shadow-xs" : "text-fg-muted hover:text-fg"
                )}
              >
                {t(`interval.${iv}`)}
              </button>
            ))}
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {shown.map((o) => {
            const id = `${o.plan}:${o.interval}`;
            return (
              <li key={id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="text-sm">
                  <p className="font-semibold text-fg">{tRoot(PLANS[o.plan].name)}</p>
                  <p className="text-xs text-muted">
                    {t(o.interval === "year" ? "pricePerYear" : "pricePerMonth", { price: price(o.plan, o.interval) })}
                    {" · "}
                    {t("creditsPerMonth", { count: PLANS[o.plan].credits })}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setPicked(id);
                    onPick(o);
                  }}
                >
                  {pending && picked === id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {current ? t("changePlan.pick") : t("checkout.pick")}
                </Button>
              </li>
            );
          })}
        </ul>

        <p className="text-xs text-muted">{current ? t("changePlan.prorationNote") : t("checkout.note")}</p>
        <p className="text-xs text-muted">{t("taxNote")}</p>
      </DialogContent>
    </Dialog>
  );
}
