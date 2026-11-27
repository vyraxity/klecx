"use client";

import * as React from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useSiteConfig } from "@/components/providers/site-config-provider";
import { useUsageByMember, useUsageSummary, useUsageTimeseries } from "@/lib/api/hooks/usage";
import { PLAN_MANAGE_HREF } from "@/lib/billing/links";
import { USAGE_KINDS, type UsageSummary } from "@/lib/usage/types";
import { UsageAreaChart } from "./usage-area-chart";
import { BarList } from "./bar-list";
import { Meter } from "./meter";
import { CreditHistory } from "./credit-history";

const RANGES = [7, 30, 90] as const;
/** The low-credit nudge shows at or below this share of the allowance. */
const LOW_CREDIT_RATIO = 0.2;

function ErrorRow({ message, onRetry, retry }: { message: string; onRetry: () => void; retry: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted">
      <span>{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {retry}
      </Button>
    </div>
  );
}

/** Step 9.3: Settings → Usage. */
export function UsageView({ userId }: { userId: string }) {
  const t = useTranslations("Usage");
  const tModels = useTranslations("Models");
  const tRoot = useTranslations();
  const format = useFormatter();
  const { billingEnabled } = useSiteConfig();
  const [period, setPeriod] = React.useState<"current" | "prev">("current");
  const [days, setDays] = React.useState<(typeof RANGES)[number]>(30);

  const summary = useUsageSummary(userId, period);
  const series = useUsageTimeseries(userId, days);
  const members = useUsageByMember(userId, period);
  const s = summary.data;

  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : null;
  const modelName = (key: string) => (tModels.has(`${key}.name`) ? tModels(`${key}.name`) : t("unknownModel"));

  const kindItems = (sum: UsageSummary) => [
    ...USAGE_KINDS.filter((k) => sum.byKind[k] !== 0 || k === "text").map((k) => ({
      key: k,
      label: t(`kinds.${k}`),
      value: sum.byKind[k],
      note:
        k === "transcription" && sum.transcriptionSeconds > 0
          ? t("seconds", { count: sum.transcriptionSeconds })
          : undefined,
    })),
    ...(sum.webSearch.searches > 0
      ? [
          {
            key: "webSearch",
            label: t("kinds.webSearch"),
            value: sum.webSearch.credits,
            note: t("searches", { count: sum.webSearch.searches }),
          },
        ]
      : []),
  ];

  const showMembers = (members.data ?? []).some((m) => !m.isYou);
  const low =
    s && period === "current" && s.allowance > 0 && s.remaining + s.topup <= s.allowance * LOW_CREDIT_RATIO;

  return (
    <div className="flex flex-col gap-6" aria-busy={summary.isFetching || undefined}>
      {/* Filters: one row above everything they scope. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-xs font-medium text-muted">
          {t("filters.period")}
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as "current" | "prev")}
            className="cursor-pointer rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="current">{t("filters.current")}</option>
            <option value="prev" disabled={s ? !s.hasPreviousPeriod : false}>
              {t("filters.previous")}
            </option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs font-medium text-muted">
          {t("filters.range")}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as (typeof RANGES)[number])}
            className="cursor-pointer rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {RANGES.map((d) => (
              <option key={d} value={d}>
                {t("filters.lastDays", { count: d })}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Allowance */}
      <SettingsSection
        title={t("allowance.title")}
        description={
          s?.periodStart
            ? s.periodEnd
              ? t("allowance.periodRange", { start: date(s.periodStart)!, end: date(s.periodEnd)! })
              : t("allowance.periodSince", { start: date(s.periodStart)! })
            : undefined
        }
        data-testid="usage-allowance"
      >
        {summary.isError ? (
          <ErrorRow message={t("loadError")} retry={t("retry")} onRetry={() => void summary.refetch()} />
        ) : !s ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className={summary.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-4xl font-bold tracking-tight text-fg">{format.number(s.used)}</p>
                <p className="text-xs text-muted">
                  {t("allowance.usedOf", { allowance: format.number(s.allowance), plan: tRoot(`Plans.${s.plan}.name`) })}
                </p>
              </div>
              {period === "current" && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                  <dt className="text-muted">{t("allowance.remaining")}</dt>
                  <dd className="text-end font-semibold text-fg tabular-nums">{format.number(s.remaining)}</dd>
                  {s.topup > 0 && (
                    <>
                      <dt className="text-muted">{t("allowance.topup")}</dt>
                      <dd className="text-end font-semibold text-fg tabular-nums">{format.number(s.topup)}</dd>
                    </>
                  )}
                  {s.resetsAt && (
                    <>
                      <dt className="text-muted">{t("allowance.resets")}</dt>
                      <dd className="text-end text-fg">{date(s.resetsAt)}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
            {period === "current" && (
              <div className="mt-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs text-muted">
                    <span>{t("allowance.left")}</span>
                    <span className="tabular-nums">
                      {format.number(s.remaining)} / {format.number(s.allowance)}
                    </span>
                  </div>
                  <Meter value={s.remaining} max={Math.max(s.allowance, s.remaining)} label={t("allowance.left")} invert />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs text-muted">
                    <span>{t("allowance.today")}</span>
                    <span className="tabular-nums">
                      {format.number(s.dailyCap.used)} / {format.number(s.dailyCap.cap)}
                    </span>
                  </div>
                  <Meter value={s.dailyCap.used} max={s.dailyCap.cap} label={t("allowance.today")} />
                </div>
              </div>
            )}
            {low && billingEnabled && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warning/10 px-3 py-2.5 text-xs text-fg">
                <span>{t("allowance.low")}</span>
                <Button asChild size="sm">
                  <Link href={PLAN_MANAGE_HREF} className="gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                    {t("allowance.upgrade")}
                  </Link>
                </Button>
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      {/* Daily usage */}
      <SettingsSection title={t("chart.title")} description={t("chart.hint")} data-testid="usage-chart">
        {series.isError ? (
          <ErrorRow message={t("loadError")} retry={t("retry")} onRetry={() => void series.refetch()} />
        ) : !series.data ? (
          <Skeleton className="h-44 w-full" />
        ) : (
          <div className={series.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
            {series.data.every((p) => p.credits === 0) ? (
              <p className="py-8 text-center text-xs text-muted">{t("chart.empty")}</p>
            ) : (
              <UsageAreaChart points={series.data} />
            )}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted hover:text-fg">{t("chart.asTable")}</summary>
              <div className="mt-2 max-h-64 overflow-y-auto">
                <table className="w-full text-start">
                  <thead className="text-muted">
                    <tr>
                      <th scope="col" className="py-1 font-medium">{t("history.csv.date")}</th>
                      <th scope="col" className="py-1 text-end font-medium">{t("history.csv.credits")}</th>
                      <th scope="col" className="py-1 text-end font-medium">{t("chart.callsHeader")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.data.map((p) => (
                      <tr key={p.day} className="border-t border-border/60">
                        <td className="py-1 text-muted">
                          {format.dateTime(new Date(`${p.day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}
                        </td>
                        <td className="py-1 text-end tabular-nums">{format.number(p.credits)}</td>
                        <td className="py-1 text-end tabular-nums">{format.number(p.generations)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )}
      </SettingsSection>

      {/* Breakdowns */}
      {s && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SettingsSection title={t("byKind.title")} description={t("byKind.hint")} data-testid="usage-by-kind">
            {s.used === 0 ? (
              <p className="text-xs text-muted">{t("empty")}</p>
            ) : (
              <BarList items={kindItems(s)} ariaLabel={t("byKind.title")} />
            )}
          </SettingsSection>
          <SettingsSection title={t("byModel.title")} description={t("byModel.hint")} data-testid="usage-by-model">
            {s.byModel.length === 0 ? (
              <p className="text-xs text-muted">{t("empty")}</p>
            ) : (
              <BarList
                items={s.byModel.map((m) => ({ key: m.modelKey, label: modelName(m.modelKey), value: m.credits }))}
                ariaLabel={t("byModel.title")}
              />
            )}
          </SettingsSection>
        </div>
      )}

      {showMembers && members.data && (
        <SettingsSection title={t("byMember.title")} description={t("byMember.hint")} data-testid="usage-by-member">
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[420px] text-start text-xs">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pe-3 font-medium">{t("byMember.person")}</th>
                  <th scope="col" className="py-2 pe-3 text-end font-medium">{t("byMember.prompts")}</th>
                  <th scope="col" className="py-2 pe-3 text-end font-medium">{t("byMember.asks")}</th>
                  <th scope="col" className="py-2 pe-3 text-end font-medium">{t("byMember.other")}</th>
                  <th scope="col" className="py-2 text-end font-medium">{t("byMember.total")}</th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => (
                  <tr key={m.userId} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pe-3 text-fg">
                      {m.isYou ? t("byMember.you") : (m.name ?? t("byMember.deleted"))}
                      {m.username && !m.isYou && <span className="ms-1 text-muted">@{m.username}</span>}
                    </td>
                    <td className="py-2 pe-3 text-end tabular-nums">{format.number(m.prompts)}</td>
                    <td className="py-2 pe-3 text-end tabular-nums">{format.number(m.asks)}</td>
                    <td className="py-2 pe-3 text-end tabular-nums">{format.number(m.other)}</td>
                    <td className="py-2 text-end font-semibold tabular-nums">{format.number(m.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsSection>
      )}

      <CreditHistory userId={userId} />
    </div>
  );
}
