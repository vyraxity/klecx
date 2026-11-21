"use client";

import * as React from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { toast } from "sonner";
import { getApiErrorMessage, readApiError } from "@/lib/api/error-message";
import { PLAN_MANAGE_HREF } from "@/lib/billing/links";
import { useTranslations } from "next-intl";
import { Check, HelpCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PLANS, PlanKey } from "@/server/billing/plans";
import { useSiteConfig } from "@/components/providers/site-config-provider";
import { isImageGenerationEnabled, visiblePlanFeatures } from "@/lib/features/image-generation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GROUNDING_SURCHARGE_CREDITS, MODEL_CATALOG } from "@/lib/ai/model-catalog";

/**
 * A plan card's button (Step 8.5). A link to sign-up that carries the chosen
 * plan and period (`/auth/register?plan=lite&interval=year`), so it works
 * without JavaScript and for crawlers. For a paid plan, a click first tries
 * the checkout: signed in → the provider's checkout; already on a paid plan
 * (409 `subscription_exists`) → Settings → Billing; signed out (401) → the
 * sign-up link.
 */
function PlanCta({
  plan,
  interval,
  popular,
  label,
}: {
  plan: PlanKey;
  interval: "month" | "year";
  popular: boolean;
  label: string;
}) {
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const href = plan === "FREE" ? "/auth/register" : `/auth/register?plan=${plan.toLowerCase()}&interval=${interval}`;

  const onClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (plan === "FREE" || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    setPending(true);
    try {
      const res = await fetch("/api/v1/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ plan, interval }),
      });
      if (res.status === 401) {
        router.push(href);
        return;
      }
      if (!res.ok) {
        const error = await readApiError(res);
        if (error.code === "subscription_exists") {
          router.push(PLAN_MANAGE_HREF);
          return;
        }
        toast.error(getApiErrorMessage(error, tRoot, tRoot("Billing.checkout.failed")));
        return;
      }
      const { data } = (await res.json()) as { data: { url: string } };
      window.location.assign(data.url);
    } catch {
      toast.error(tRoot("Billing.checkout.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      asChild
      variant={popular ? "default" : "outline"}
      className={cn(
        "w-full text-xs font-semibold h-9",
        popular
          ? "bg-accent text-accent-fg hover:bg-accent-hover shadow-2xs"
          : "border-border text-fg hover:bg-surface-2"
      )}
    >
      <Link href={href} onClick={onClick} aria-busy={pending || undefined}>
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {label}
      </Link>
    </Button>
  );
}

export function MarketingPricingTable({
  isTeaser: _isTeaser = false,
}: {
  isTeaser?: boolean;
}) {
  const t = useTranslations("Marketing.pricing");
  const tPlans = useTranslations();
  const { billingEnabled } = useSiteConfig();
  const imagesOn = isImageGenerationEnabled();
  const [billingCycle, setBillingCycle] = React.useState<"month" | "year">("month");

  const planKeys: PlanKey[] = ["FREE", "LITE", "STANDARD", "PRO"];

  return (
    <section id="pricing" className="py-12 md:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-10 space-y-3">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-accent/20 bg-accent-soft text-accent text-xs font-semibold">
            <span>{t("badge")}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-fg">
            {t("heading")}
          </h2>
          <p className="text-sm sm:text-base text-fg-muted">
            {t("subheading")}
          </p>

          {/* Monthly / Yearly Toggle */}
          <div className="pt-4 flex items-center justify-center">
            <div className="inline-flex items-center p-1 rounded-xl border border-border bg-surface-2 shadow-2xs">
              <button
                type="button"
                onClick={() => setBillingCycle("month")}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer",
                  billingCycle === "month"
                    ? "bg-surface text-fg shadow-xs"
                    : "text-fg-muted hover:text-fg"
                )}
              >
                {t("monthlyBilling")}
              </button>
              <button
                type="button"
                onClick={() => setBillingCycle("year")}
                className={cn(
                  "flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer",
                  billingCycle === "year"
                    ? "bg-surface text-fg shadow-xs"
                    : "text-fg-muted hover:text-fg"
                )}
              >
                <span>{t("yearlyBilling")}</span>
                <span className="px-1.5 py-0.5 rounded-full bg-accent-soft text-accent text-[10px] font-bold">
                  {t("twoMonthsFree")}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Billing Disabled Notice */}
        {!billingEnabled && (
          <div className="mb-8 rounded-xl border border-accent/20 bg-accent-soft/40 p-4 text-center text-xs text-fg sm:text-sm">
            {t("paidPlansNotice")}
          </div>
        )}

        {/* Pricing Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
          {planKeys.map((key) => {
            const plan = PLANS[key];
            const isPopular = plan.popular;
            const price = billingCycle === "year" ? plan.priceYearly : plan.priceMonthly;
            const period = billingCycle === "year" ? t("perYear") : t("perMonth");

            return (
              <div
                key={plan.id}
                className={cn(
                  "relative flex flex-col justify-between rounded-2xl border p-6 transition-all duration-200",
                  isPopular
                    ? "border-accent bg-surface shadow-md ring-1 ring-accent"
                    : "border-border bg-surface shadow-2xs hover:border-border-strong"
                )}
              >
                {/* Popular Badge */}
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-accent text-accent-fg px-3 py-0.5 text-xs font-semibold shadow-xs">
                      {t("mostPopular")}
                    </Badge>
                  </div>
                )}

                {/* Card Top */}
                <div className="space-y-4">
                  <div>
                    <h3 className="text-lg font-bold text-fg">
                      {tPlans(plan.name)}
                    </h3>
                    <p className="mt-1 text-xs text-fg-muted leading-relaxed min-h-[32px]">
                      {tPlans(plan.tagline)}
                    </p>
                  </div>

                  {/* Price */}
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl sm:text-4xl font-extrabold tracking-tight text-fg">
                      {t("priceFormat", { price })}
                    </span>
                    <span className="text-xs text-fg-muted font-medium">{period}</span>
                  </div>

                  {/* Credit Metric */}
                  <div className="p-3 rounded-xl border border-border/80 bg-surface-2 text-xs space-y-1">
                    <div className="font-semibold text-fg flex items-center justify-between">
                      <span>{t("creditsCount", { count: plan.credits })}</span>
                      <span className="text-[10px] text-fg-subtle">{t("creditsRenewed")}</span>
                    </div>
                    <div className="text-[11px] text-fg-muted">
                      {plan.dailyCapCredits
                        ? t("dailyCapFixed", { credits: plan.dailyCapCredits })
                        : t("dailyCapPercent", { percent: Math.round((plan.dailyCapPct || 0.25) * 100) })}
                    </div>
                  </div>

                  {/* Feature Checklist */}
                  <div className="space-y-2 pt-2 border-t border-border/60">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
                      {t("includedHeading")}
                    </div>
                    <ul className="space-y-2 text-xs">
                      {visiblePlanFeatures(plan.features).map((featureKey) => (
                        <li key={featureKey} className="flex items-start gap-2 text-fg/90">
                          <Check className="h-3.5 w-3.5 text-accent shrink-0 mt-0.5" />
                          <span>{tPlans(featureKey)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Action CTA */}
                <div className="pt-6 mt-6 border-t border-border/60">
                  {plan.id !== "FREE" && !billingEnabled ? (
                    // A disabled button gets no pointer events, so the tooltip sits on a focusable wrapper.
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="block w-full cursor-not-allowed rounded-md">
                          <Button
                            disabled
                            variant="outline"
                            className="pointer-events-none w-full text-xs font-semibold h-9 border-border text-fg-muted"
                          >
                            {t("comingSoon")}
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{t("paidPlansTooltip")}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <PlanCta
                      plan={plan.id}
                      interval={billingCycle}
                      popular={Boolean(isPopular)}
                      label={plan.id === "FREE" ? t("startFree") : t("subscribeTo", { name: tPlans(plan.name) })}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Step 8.5: prices are shown before tax (owner decided 2026-11-20). */}
        {billingEnabled && (
          <p className="mt-6 text-center text-xs text-fg-muted">{tPlans("Billing.taxNote")}</p>
        )}

        {/* Transparent Credit Breakdown Footnote */}
        <div className="mt-12 p-6 rounded-2xl border border-border bg-surface-2/60 text-xs text-fg-muted space-y-3">
          <div className="font-semibold text-fg flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-accent" />
            <span>{t("footnoteTitle")}</span>
          </div>
          <div
            className={cn(
              "grid grid-cols-1 gap-4 pt-1 text-xs",
              imagesOn ? "sm:grid-cols-3" : "sm:grid-cols-2"
            )}
          >
            <div className="p-3 rounded-xl bg-surface border border-border/60 space-y-1">
              <span className="font-semibold text-fg">{t("standardTurnTitle")}</span>
              <p className="text-[11px] text-fg-subtle">{t("standardTurnDesc", { credits: MODEL_CATALOG["text-standard"].typicalCredits })}</p>
            </div>
            {imagesOn && (
              <div className="p-3 rounded-xl bg-surface border border-border/60 space-y-1">
                <span className="font-semibold text-fg">{t("imageGenTitle")}</span>
                <p className="text-[11px] text-fg-subtle">{t("imageGenDesc", { credits: MODEL_CATALOG["image-standard"].typicalCredits })}</p>
              </div>
            )}
            <div className="p-3 rounded-xl bg-surface border border-border/60 space-y-1">
              <span className="font-semibold text-fg">{t("groundingTitle")}</span>
              <p className="text-[11px] text-fg-subtle">{t("groundingDesc", { credits: GROUNDING_SURCHARGE_CREDITS })}</p>
            </div>
          </div>
          <p className="text-[11px] text-fg-subtle pt-1">
            {t("footnoteDisclaimer")}
          </p>
        </div>
      </div>
    </section>
  );
}

export default MarketingPricingTable;
