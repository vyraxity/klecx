"use client";

import * as React from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks/query-keys";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/error-message";

interface IncomingTransfer {
  id: string;
  expiresAt: string;
  workspace: { id: string; title: string } | null;
  project: { id: string; name: string } | null;
  fromUser: { id: string; name: string | null } | null;
}

const TRANSFER_ERRORS: Record<string, string> = {
  transfer_busy: "errors.busy",
  transfer_expired: "errors.expired",
  transfer_not_pending: "errors.notPending",
};

/**
 * Step 9.1: ownership-transfer requests sent to me (F1.3), with Accept and
 * Decline. Hidden when there are none.
 */
export function OwnershipTransfersCard({ userId }: { userId: string }) {
  const t = useTranslations("Settings.profilePage");
  const tTransfer = useTranslations("Transfer");
  const tRoot = useTranslations();
  const format = useFormatter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const query = useQuery({
    queryKey: queryKeys.me.incomingTransfers(userId),
    queryFn: ({ signal }) =>
      api<{ transfers: IncomingTransfer[] }>("/api/v1/me/ownership-transfers", { signal }).then(
        (d) => d.transfers
      ),
  });
  const items = query.data ?? null;
  const failed = query.isError;
  const load = () => void query.refetch();

  const act = async (id: string, action: "accept" | "decline") => {
    setBusyId(id);
    try {
      const data = await api<{ detachedFromProject?: boolean }>(
        `/api/v1/ownership-transfers/${id}/${action}`,
        { method: "POST" }
      );
      if (action === "accept") {
        toast.success(
          data?.detachedFromProject ? tTransfer("errors.movedOutOfProject") : tTransfer("accepted")
        );
      } else {
        toast.success(tTransfer("declined"));
      }
    } catch (err) {
      const code = getApiErrorCode(err) ?? "";
      const key = TRANSFER_ERRORS[code];
      toast.error(
        code === "transfer_member_limit"
          ? t("transferMemberLimit")
          : key
            ? tTransfer(key)
            : getApiErrorMessage(err, tRoot, tTransfer("errors.generic"))
      );
    } finally {
      setBusyId(null);
      load();
    }
  };

  if (failed) {
    return (
      <SettingsSection title={t("transfersTitle")}>
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>{t("transfersLoadError")}</span>
          <Button size="sm" variant="outline" onClick={load}>
            {t("retry")}
          </Button>
        </div>
      </SettingsSection>
    );
  }
  if (items === null) return <Skeleton className="h-24 w-full rounded-2xl" />;
  if (items.length === 0) return null;

  return (
    <SettingsSection
      title={t("transfersTitle")}
      description={tTransfer("incomingPays")}
      data-testid="settings-transfers"
    >
      <ul className="flex flex-col divide-y divide-border">
        {items.map((tr) => {
          const isProject = Boolean(tr.project);
          const name = tr.project?.name ?? tr.workspace?.title ?? "";
          const href = tr.project ? `/projects/${tr.project.id}` : `/workspaces/${tr.workspace?.id}`;
          return (
            <li key={tr.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="text-fg">
                  {t("transferFrom", {
                    name: tr.fromUser?.name || tTransfer("someone"),
                    type: isProject ? "project" : "workspace",
                  })}{" "}
                  <Link href={href} className="font-semibold underline-offset-2 hover:underline">
                    {name}
                  </Link>
                </p>
                <p className="text-xs text-muted">
                  {t("transferExpires", {
                    date: format.dateTime(new Date(tr.expiresAt), { dateStyle: "medium" }),
                  })}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" disabled={busyId !== null} onClick={() => void act(tr.id, "accept")}>
                  {tTransfer("accept")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => void act(tr.id, "decline")}
                >
                  {tTransfer("decline")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
