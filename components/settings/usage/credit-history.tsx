"use client";

import * as React from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { SettingsSection } from "@/components/settings/settings-section";
import { useCreditHistory } from "@/lib/api/hooks/usage";
import { CREDIT_HISTORY_TYPES, type CreditHistoryEntry, type CreditHistoryType } from "@/lib/usage/types";
import { cn } from "@/lib/utils";

/** Step 9.3: the credit history, filterable by type, with a CSV download. */
export function CreditHistory({ userId }: { userId: string }) {
  const t = useTranslations("Usage");
  const tModels = useTranslations("Models");
  const format = useFormatter();
  const [type, setType] = React.useState<CreditHistoryType>("all");
  const query = useCreditHistory(userId, type);
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  const modelName = (key: string) => (tModels.has(`${key}.name`) ? tModels(`${key}.name`) : key);
  const describe = (e: CreditHistoryEntry) => {
    if (e.type !== "usage") return t(`history.reasons.${e.label}`);
    const kind = t(`kinds.${e.label}`);
    return e.workspaceTitle ? t("history.inWorkspace", { kind, workspace: e.workspaceTitle }) : kind;
  };

  return (
    <SettingsSection
      title={t("history.title")}
      description={t("history.hint")}
      data-testid="usage-history"
      actions={
        <Button asChild size="sm" variant="outline">
          <a href={`/api/v1/me/credits/history?type=${type}&format=csv`} download>
            <Download className="h-4 w-4" aria-hidden />
            {t("history.csv.download")}
          </a>
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="usage-history-type" className="text-xs font-medium text-muted">
          {t("history.filter")}
        </label>
        <select
          id="usage-history-type"
          value={type}
          onChange={(e) => setType(e.target.value as CreditHistoryType)}
          className="cursor-pointer rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {CREDIT_HISTORY_TYPES.map((v) => (
            <option key={v} value={v}>
              {t(`history.types.${v}`)}
            </option>
          ))}
        </select>
      </div>

      {query.isError ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>{t("history.loadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        </div>
      ) : query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted">{t("history.empty")}</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[520px] text-left text-xs">
            <caption className="sr-only">{t("history.title")}</caption>
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-3 font-medium">{t("history.csv.date")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("history.csv.description")}</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">{t("history.csv.credits")}</th>
                <th scope="col" className="py-2 text-right font-medium">{t("history.csv.balance")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-border/60 align-top last:border-0">
                  <td className="whitespace-nowrap py-2 pr-3 text-muted tabular-nums">
                    {format.dateTime(new Date(e.at), { dateStyle: "medium", timeStyle: "short" })}
                  </td>
                  <td className="py-2 pr-3 text-fg">
                    {e.type === "usage" && e.workspaceId && e.workspaceTitle ? (
                      <span>
                        {t("kinds." + e.label)} ·{" "}
                        <Link href={`/workspaces/${e.workspaceId}`} className="underline-offset-2 hover:underline">
                          {e.workspaceTitle}
                        </Link>
                      </span>
                    ) : (
                      describe(e)
                    )}
                    <span className="block text-[11px] text-muted">
                      {[
                        e.byOther ? t("history.by", { name: e.actorName ?? t("history.someone") }) : null,
                        e.modelKey ? modelName(e.modelKey) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </td>
                  <td
                    className={cn(
                      "whitespace-nowrap py-2 pr-3 text-right font-semibold tabular-nums",
                      e.amount > 0 ? "text-success" : "text-fg"
                    )}
                  >
                    {format.number(e.amount, { signDisplay: "exceptZero" })}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right text-muted tabular-nums">
                    {format.number(e.balanceAfter)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {query.hasNextPage && (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage && <Spinner size="sm" />}
            {t("history.more")}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
