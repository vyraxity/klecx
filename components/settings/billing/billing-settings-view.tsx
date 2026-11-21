"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, CreditCard, ExternalLink, LifeBuoy, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useSiteConfig } from "@/components/providers/site-config-provider";
import {
  useCancelSubscription,
  useChangePlan,
  useMySubscription,
  useOpenBillingPortal,
  useResumeSubscription,
  useStartCheckout,
  type MySubscription,
} from "@/lib/api/hooks/billing";
import { getApiErrorMessage } from "@/lib/api/error-message";
import { REFUND_POLICY_HREF } from "@/lib/billing/links";
import { upgradeOptions, type Interval, type PaidPlan } from "@/lib/billing/plan-changes";
import { PLANS, type PlanKey } from "@/server/billing/plans";
import { PlanPicker } from "./plan-picker";
import { ConsentCheckbox } from "@/components/billing/consent-checkbox";

/** How long the page waits for the webhook after a checkout before saying it takes longer than usual. */
export const ACTIVATION_TIMEOUT_MS = 60_000;
const ACTIVATION_POLL_MS = 2_000;

export interface BillingSettingsViewProps {
  userId: string;
  /** `?checkout=success`: back from the provider's checkout. */
  checkoutReturned: boolean;
  /** `?subscribe=lite&interval=year`: the plan chosen on the pricing page before signing up. */
  intent: { plan: PaidPlan; interval: Interval } | null;
}

type Sub = NonNullable<MySubscription["subscription"]>;

function statusKey(sub: Sub): string {
  if (sub.paymentIssue) return "paymentIssue";
  if (sub.status === "DISPUTED") return "onHold";
  if (sub.status === "CANCELED" || sub.status === "EXPIRED") return "ended";
  if (sub.status === "PAUSED") return "paused";
  if (sub.cancelAtPeriodEnd) return "cancelScheduled";
  if (sub.status === "TRIALING") return "trial";
  return "active";
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
  active: "success",
  trial: "secondary",
  cancelScheduled: "warning",
  paused: "warning",
  paymentIssue: "destructive",
  onHold: "destructive",
  ended: "secondary",
};

export function BillingSettingsView({ userId, checkoutReturned, intent }: BillingSettingsViewProps) {
  const t = useTranslations("Billing");
  const tRoot = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const { billingEnabled } = useSiteConfig();

  const [activationStartedAt] = React.useState(() => (checkoutReturned ? Date.now() : 0));
  const [activationTimedOut, setActivationTimedOut] = React.useState(false);
  const [waitingForActivation, setWaitingForActivation] = React.useState(checkoutReturned);

  const { data, isLoading, isError } = useMySubscription(userId, {
    refetchInterval: waitingForActivation ? ACTIVATION_POLL_MS : false,
  });

  const checkout = useStartCheckout();
  const portal = useOpenBillingPortal();
  const cancel = useCancelSubscription(userId);
  const resume = useResumeSubscription(userId);
  const changePlan = useChangePlan(userId);

  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [intentConsent, setIntentConsent] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const showError = React.useCallback(
    (err: unknown, fallbackKey: string) => toast.error(getApiErrorMessage(err, tRoot, t(fallbackKey))),
    [t, tRoot]
  );

  // Back from checkout: poll until the webhook has activated the plan, give up after 60 s.
  const activated = Boolean(data && data.effectivePlan !== "FREE");
  React.useEffect(() => {
    if (!waitingForActivation) return;
    if (activated) {
      setWaitingForActivation(false);
      toast.success(t("activation.done"));
      router.replace("/settings/billing");
      return;
    }
    const left = activationStartedAt + ACTIVATION_TIMEOUT_MS - Date.now();
    const timer = setTimeout(() => {
      setWaitingForActivation(false);
      setActivationTimedOut(true);
    }, Math.max(0, left));
    return () => clearTimeout(timer);
  }, [waitingForActivation, activated, activationStartedAt, router, t]);

  const formatDate = (iso: string | null | undefined) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "long" }) : null;
  const planName = (plan: PlanKey) => tRoot(PLANS[plan].name);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }
  if (isError || !data) {
    return <p className="text-sm text-danger">{t("loadFailed")}</p>;
  }

  const sub = data.subscription;
  const effective = data.effectivePlan;
  const isFree = effective === "FREE";
  const current = sub && !isFree ? { plan: sub.plan, interval: sub.interval } : null;
  const options = current ? upgradeOptions(current) : upgradeOptions({ plan: "FREE", interval: "month" });

  /** Called only once the consent to immediate start was ticked (plan picker, intent card). */
  const onPick = (target: { plan: PaidPlan; interval: Interval }) => {
    const input = { ...target, consentImmediateStart: true as const };
    if (current) {
      changePlan.mutate(input, {
        onSuccess: () => {
          setPickerOpen(false);
          toast.success(t("changePlan.done", { plan: planName(target.plan) }));
        },
        onError: (err) => showError(err, "changePlan.failed"),
      });
    } else {
      checkout.mutate(input, { onError: (err) => showError(err, "checkout.failed") });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Back from checkout */}
      {waitingForActivation && (
        <div role="status" className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 p-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span>{t("activation.waiting")}</span>
        </div>
      )}
      {activationTimedOut && !activated && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5" />
          <span>{t("activation.slow")}</span>
        </div>
      )}

      {/* A renewal payment failed */}
      {sub?.paymentIssue && billingEnabled && (
        <div role="alert" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4">
          <div className="flex items-start gap-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-danger mt-0.5 shrink-0" />
            <span>{t("pastDue.body", { plan: planName(sub.plan) })}</span>
          </div>
          {sub.canManage && (
            <Button size="sm" variant="outline" disabled={portal.isPending} onClick={() => portal.mutate(undefined, { onError: (e) => showError(e, "portal.failed") })}>
              {t("pastDue.action")}
            </Button>
          )}
        </div>
      )}

      {/* Plan chosen before signing up */}
      {intent && isFree && billingEnabled && !waitingForActivation && (
        <div className="flex flex-col gap-3 rounded-xl border border-accent/30 bg-surface p-4">
          <div className="text-sm">
            <p className="font-semibold text-fg">
              {t("intent.title", { plan: planName(intent.plan), interval: t(`interval.${intent.interval}`) })}
            </p>
            <p className="text-xs text-muted mt-0.5">{t("taxNote")}</p>
          </div>
          <ConsentCheckbox id="intent-consent" checked={intentConsent} onCheckedChange={setIntentConsent} />
          <Button size="sm" className="self-start" disabled={checkout.isPending || !intentConsent} onClick={() => onPick(intent)}>
            {checkout.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {t("intent.action")}
          </Button>
        </div>
      )}

      {/* Current plan */}
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-xs flex flex-col gap-4" aria-labelledby="billing-current-plan">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("currentPlan")}</p>
            <h2 id="billing-current-plan" className="text-xl font-bold text-fg flex items-center gap-2">
              {planName(sub && !isFree ? sub.plan : effective)}
              {sub && !isFree && (
                <span className="text-sm font-medium text-muted">· {t(`interval.${sub.interval}`)}</span>
              )}
            </h2>
          </div>
          {sub ? (
            <Badge variant={STATUS_VARIANT[statusKey(sub)] ?? "outline"} data-status={statusKey(sub)}>
              {t(`status.${statusKey(sub)}`, { date: formatDate(sub.currentPeriodEnd) ?? "" })}
            </Badge>
          ) : (
            <Badge variant="outline">{t("status.free")}</Badge>
          )}
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {sub && !isFree && sub.currentPeriodEnd && (
            <div>
              <dt className="text-xs text-muted">{sub.cancelAtPeriodEnd ? t("endsOn") : t("renewsOn")}</dt>
              <dd className="font-medium text-fg">{formatDate(sub.currentPeriodEnd)}</dd>
            </div>
          )}
          {data.resetsAt && (
            <div>
              <dt className="text-xs text-muted">{t("creditsResetOn")}</dt>
              <dd className="font-medium text-fg">{formatDate(data.resetsAt)}</dd>
            </div>
          )}
        </dl>

        {!billingEnabled ? (
          <p className="text-sm text-muted">{t("launchingSoon")}</p>
        ) : (
          <div className="flex flex-wrap gap-2 pt-1">
            {isFree && (
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                <Sparkles className="h-3.5 w-3.5" />
                {t("upgrade")}
              </Button>
            )}
            {sub?.canChangePlan && options.length > 0 && (
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                <Sparkles className="h-3.5 w-3.5" />
                {t("changePlan.open")}
              </Button>
            )}
            {sub?.canResume && (
              <Button
                size="sm"
                disabled={resume.isPending}
                onClick={() =>
                  resume.mutate(undefined, {
                    onSuccess: () => toast.success(t("resume.done")),
                    onError: (err) => showError(err, "resume.failed"),
                  })
                }
              >
                {t("resume.action")}
              </Button>
            )}
            {sub?.canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={portal.isPending}
                onClick={() => portal.mutate(undefined, { onError: (e) => showError(e, "portal.failed") })}
              >
                <CreditCard className="h-3.5 w-3.5" />
                {t("portal.action")}
                <ExternalLink className="h-3 w-3 opacity-60" />
              </Button>
            )}
            {sub?.canCancel && !isFree && (
              <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setCancelOpen(true)}>
                {t("cancel.action")}
              </Button>
            )}
          </div>
        )}

        {billingEnabled && sub?.canManage && (
          <p className="text-xs text-muted">{t("portal.note")}</p>
        )}
        {billingEnabled && sub?.canChangePlan && (
          <p className="text-xs text-muted">{t("changePlan.downgradeNote")}</p>
        )}
      </section>

      {/* Refunds */}
      {billingEnabled && sub && (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3 text-sm">
            <LifeBuoy className="h-4 w-4 text-accent mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-fg">{t("refund.title")}</p>
              <p className="text-xs text-muted mt-0.5">
                {t("refund.body")}{" "}
                <Link href={REFUND_POLICY_HREF} className="underline underline-offset-2 hover:text-fg">
                  {t("refund.policyLink")}
                </Link>
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/support?topic=billing&refund=1">{t("refund.action")}</Link>
          </Button>
        </section>
      )}

      {pickerOpen && (
        <PlanPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          current={current}
          options={options}
          pending={checkout.isPending || changePlan.isPending}
          onPick={onPick}
        />
      )}

      {sub && (
        <ConfirmDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title={t("cancel.title")}
          description={
            <span className="flex flex-col gap-2">
              <span>
                {t("cancel.body", { plan: planName(sub.plan), date: formatDate(sub.currentPeriodEnd) ?? "" })}
              </span>
              <span className="text-xs text-muted">{t("cancel.after")}</span>
            </span>
          }
          confirmLabel={t("cancel.confirm")}
          cancelLabel={t("cancel.keep")}
          variant="destructive"
          loading={cancel.isPending}
          onConfirm={async () => {
            try {
              await cancel.mutateAsync();
              setCancelOpen(false);
              toast.success(t("cancel.done", { date: formatDate(sub.currentPeriodEnd) ?? "" }));
            } catch (err) {
              showError(err, "cancel.failed");
            }
          }}
        />
      )}

      {activated && !waitingForActivation && checkoutReturned && (
        <p className="sr-only" role="status">
          <CheckCircle2 aria-hidden /> {t("activation.done")}
        </p>
      )}
    </div>
  );
}
