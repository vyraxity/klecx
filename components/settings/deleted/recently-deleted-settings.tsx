"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SettingsSection } from "@/components/settings/settings-section";
import { api } from "@/lib/api/client";
import { getApiErrorMessage } from "@/lib/api/error-message";
import { queryKeys } from "@/lib/api/hooks/query-keys";

interface DeletedItemBase {
  id: string;
  deletedAt: string;
  purgeAt: string;
  daysLeft: number;
}

interface RecentlyDeleted {
  retentionDays: number;
  workspaces: Array<DeletedItemBase & { title: string; deletedProjectName: string | null }>;
  projects: Array<DeletedItemBase & { name: string; workspaceCount: number }>;
}

/**
 * Pre-10.6 fix: lists the person's deleted workspaces and projects that can
 * still be restored (`GET /api/v1/me/recently-deleted`) and restores them
 * (`POST /api/v1/workspaces/:id/restore`, `POST /api/v1/projects/:id/restore`).
 * There is no "delete permanently now" (owner's decision).
 */
export function RecentlyDeletedSettings({ userId }: { userId: string }) {
  const t = useTranslations("Settings.deleted");
  const tRoot = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = React.useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.me.recentlyDeleted(userId),
    queryFn: ({ signal }) => api<RecentlyDeleted>("/api/v1/me/recently-deleted", { signal }),
  });

  const restore = async (kind: "workspace" | "project", id: string, label: string) => {
    setRestoring(id);
    try {
      await api(`/api/v1/${kind === "workspace" ? "workspaces" : "projects"}/${id}/restore`, {
        method: "POST",
      });
      toast.success(t(kind === "workspace" ? "restoredWorkspace" : "restoredProject", { name: label }), {
        action: {
          label: t("open"),
          onClick: () => router.push(kind === "workspace" ? `/workspaces/${id}` : `/projects/${id}`),
        },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me.recentlyDeleted(userId) });
      // The sidebar's lists come from the layout.
      router.refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("restoreError")));
    } finally {
      setRestoring(null);
    }
  };

  const left = (item: DeletedItemBase) =>
    item.daysLeft === 0
      ? t("lastDay")
      : t("daysLeft", { count: item.daysLeft, date: format.dateTime(new Date(item.purgeAt), { dateStyle: "medium" }) });
  const deletedOn = (item: DeletedItemBase) =>
    t("deletedOn", { date: format.dateTime(new Date(item.deletedAt), { dateStyle: "medium" }) });

  if (isLoading) {
    return (
      <SettingsSection title={t("workspacesTitle")}>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size="sm" />
          {t("loading")}
        </div>
      </SettingsSection>
    );
  }
  if (isError || !data) {
    return (
      <SettingsSection title={t("workspacesTitle")}>
        <p className="text-xs text-danger" role="alert">
          {t("loadError")}
        </p>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title={t("workspacesTitle")} data-testid="deleted-workspaces">
        {data.workspaces.length === 0 ? (
          <p className="text-xs text-muted">{t("noWorkspaces")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.workspaces.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-start gap-2.5">
                  <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{w.title || t("untitled")}</p>
                    <p className="text-xs text-muted">
                      {deletedOn(w)} · {left(w)}
                    </p>
                    {w.deletedProjectName && (
                      <p className="text-xs text-muted">
                        {t("projectAlsoDeleted", { project: w.deletedProjectName })}
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={restoring !== null}
                  onClick={() => restore("workspace", w.id, w.title || t("untitled"))}
                  aria-label={t("restoreNamed", { name: w.title || t("untitled") })}
                >
                  {restoring === w.id && <Spinner size="sm" />}
                  {t("restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title={t("projectsTitle")} description={t("projectsHint")} data-testid="deleted-projects">
        {data.projects.length === 0 ? (
          <p className="text-xs text-muted">{t("noProjects")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-start gap-2.5">
                  <FolderKanban className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{p.name}</p>
                    <p className="text-xs text-muted">
                      {deletedOn(p)} · {left(p)}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={restoring !== null}
                  onClick={() => restore("project", p.id, p.name)}
                  aria-label={t("restoreNamed", { name: p.name })}
                >
                  {restoring === p.id && <Spinner size="sm" />}
                  {t("restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <p className="text-xs text-muted">
        {t("footnote", { days: data.retentionDays })}{" "}
        <Link href="/privacy" className="underline hover:text-fg">
          {t("privacyLink")}
        </Link>
      </p>
    </>
  );
}
