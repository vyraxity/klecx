"use client";

import * as React from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks/query-keys";

interface MyTicket {
  id: string;
  topic: string;
  excerpt: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  createdAt: string;
  screenshotCount: number;
}

const KNOWN_TOPICS = new Set(["general", "billing", "account", "bug", "feature", "other"]);

/** Step 9.1: the support requests I sent while signed in (newest first). */
export function MyTicketsCard({ userId }: { userId: string }) {
  const t = useTranslations("Settings.support");
  const tSupport = useTranslations("Support");
  const format = useFormatter();
  const query = useQuery({
    queryKey: queryKeys.me.supportTickets(userId),
    queryFn: ({ signal }) =>
      api<{ tickets: MyTicket[] }>("/api/v1/me/support-tickets", { signal }).then((d) => d.tickets),
  });
  const tickets = query.data ?? null;
  const failed = query.isError;

  return (
    <SettingsSection title={t("ticketsTitle")} description={t("ticketsHint")} data-testid="settings-tickets">
      {failed ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>{t("ticketsLoadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        </div>
      ) : tickets === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : tickets.length === 0 ? (
        <p className="text-xs text-muted">{t("ticketsEmpty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {tickets.map((ticket) => (
            <li key={ticket.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-fg">
                  {KNOWN_TOPICS.has(ticket.topic) ? tSupport(`topics.${ticket.topic}`) : ticket.topic}
                </span>
                <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
                  {t(`status.${ticket.status}`)}
                </span>
              </div>
              <p className="line-clamp-2 break-words text-xs text-muted">{ticket.excerpt}</p>
              <p className="text-[11px] text-subtle">
                {format.dateTime(new Date(ticket.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                {" · "}
                {t("ticketId", { id: ticket.id.slice(0, 8) })}
                {ticket.screenshotCount > 0 && ` · ${t("screenshots", { count: ticket.screenshotCount })}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
