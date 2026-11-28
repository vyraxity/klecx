import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { DeletedAndArchivedSettings } from "@/components/settings/deleted/deleted-and-archived-settings";
import { SettingsPageHeader } from "@/components/settings/settings-section";
import { DELETED_RETENTION_DAYS } from "@/server/jobs/cleanup";
import { deletedPageTab } from "@/lib/settings/deleted-tabs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.deleted");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/**
 * Settings → Deleted & archived (pre-10.6 fixes PR 6 and PR 8). Deleted tab:
 * the person's own workspaces and projects deleted in the last 30 days, each
 * with the days left and Restore. Archived tab (`?tab=archived`): archived
 * workspaces and projects they can open, with Unarchive.
 */
export default async function DeletedAndArchivedPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [actor, t, params] = await Promise.all([
    requireActor(),
    getTranslations("Settings.deleted"),
    searchParams,
  ]);
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description", { days: DELETED_RETENTION_DAYS })} />
      <DeletedAndArchivedSettings userId={actor.userId} initialTab={deletedPageTab(params.tab)} />
    </>
  );
}
