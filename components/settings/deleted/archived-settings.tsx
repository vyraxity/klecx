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

interface ArchivedItemBase {
  id: string;
  archivedAt: string;
  shared: boolean;
  canUnarchive: boolean;
}

interface Archived {
  workspaces: Array<ArchivedItemBase & { title: string; projectName: string | null }>;
  projects: Array<ArchivedItemBase & { name: string; workspaceCount: number }>;
}

type Kind = "workspace" | "project";
const WORKSPACE: Kind = "workspace";
const PROJECT: Kind = "project";

/**
 * Pre-10.6 fix PR 8: the Archived tab of Settings → Deleted & archived.
 * Lists the archived workspaces and projects the person can open
 * (`GET /api/v1/me/archived`) and takes them out of the archive
 * (`PATCH /api/v1/workspaces/:id` / `PATCH /api/v1/projects/:id` with
 * `{ archived: false }`), when the person may.
 */
export function ArchivedSettings({ userId }: { userId: string }) {
  const t = useTranslations("Settings.deleted");
  const tRoot = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.me.archived(userId),
    queryFn: ({ signal }) => api<Archived>("/api/v1/me/archived", { signal }),
  });

  const hrefOf = (kind: Kind, id: string) => (kind === "workspace" ? `/workspaces/${id}` : `/projects/${id}`);

  const unarchive = async (kind: Kind, id: string, label: string) => {
    setBusy(id);
    try {
      await api(`/api/v1/${kind === "workspace" ? "workspaces" : "projects"}/${id}`, {
        method: "PATCH",
        body: { archived: false },
      });
      toast.success(t(kind === "workspace" ? "unarchivedWorkspace" : "unarchivedProject", { name: label }), {
        action: { label: t("open"), onClick: () => router.push(hrefOf(kind, id)) },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me.archived(userId) });
      // The sidebar's lists come from the layout.
      router.refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("unarchiveError")));
    } finally {
      setBusy(null);
    }
  };

  const archivedOn = (item: ArchivedItemBase) =>
    t("archivedOn", { date: format.dateTime(new Date(item.archivedAt), { dateStyle: "medium" }) });

  const row = (kind: Kind, item: ArchivedItemBase, label: string, details: string[]) => {
    const Icon = kind === "workspace" ? MessageSquare : FolderKanban;
    return (
      <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <Link
              href={hrefOf(kind, item.id)}
              className="block truncate text-sm font-medium text-fg hover:underline"
              aria-label={t("openNamed", { name: label })}
            >
              {label}
            </Link>
            <p className="text-xs text-muted">{[archivedOn(item), ...details].join(" · ")}</p>
            {!item.canUnarchive && <p className="text-xs text-muted">{t("cannotUnarchive")}</p>}
          </div>
        </div>
        {item.canUnarchive && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => unarchive(kind, item.id, label)}
            aria-label={t("unarchiveNamed", { name: label })}
          >
            {busy === item.id && <Spinner size="sm" />}
            {t("unarchive")}
          </Button>
        )}
      </li>
    );
  };

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
          {t("archivedLoadError")}
        </p>
      </SettingsSection>
    );
  }

  return (
    <>
      <p className="text-xs text-muted">{t("archivedIntro")}</p>
      <SettingsSection title={t("workspacesTitle")} data-testid="archived-workspaces">
        {data.workspaces.length === 0 ? (
          <p className="text-xs text-muted">{t("noArchivedWorkspaces")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.workspaces.map((w) =>
              row(WORKSPACE, w, w.title || t("untitled"), [
                ...(w.projectName ? [t("inProject", { project: w.projectName })] : []),
                ...(w.shared ? [t("sharedWithYou")] : []),
              ])
            )}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title={t("projectsTitle")} data-testid="archived-projects">
        {data.projects.length === 0 ? (
          <p className="text-xs text-muted">{t("noArchivedProjects")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.projects.map((p) =>
              row(PROJECT, p, p.name, [
                t("projectWorkspaces", { count: p.workspaceCount }),
                ...(p.shared ? [t("sharedWithYou")] : []),
              ])
            )}
          </ul>
        )}
      </SettingsSection>
    </>
  );
}
