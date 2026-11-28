import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { RecentlyDeletedSettings } from "@/components/settings/deleted/recently-deleted-settings";
import { SettingsPageHeader } from "@/components/settings/settings-section";
import { DELETED_RETENTION_DAYS } from "@/server/jobs/cleanup";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.deleted");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/**
 * Pre-10.6 fix: Settings → Recently deleted. The person's own workspaces and
 * projects deleted in the last 30 days, each with the days left and Restore.
 */
export default async function RecentlyDeletedPage() {
  const actor = await requireActor();
  const t = await getTranslations("Settings.deleted");
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description", { days: DELETED_RETENTION_DAYS })} />
      <RecentlyDeletedSettings userId={actor.userId} />
    </>
  );
}
