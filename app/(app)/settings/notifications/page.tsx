import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { NotificationsSettingsView } from "@/components/notifications/NotificationsSettingsView";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Notifications.page");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/** Step 7.7, moved under the Settings shell in Step 9.1. */
export default async function NotificationsSettingsPage() {
  await requireActor();
  const t = await getTranslations("Notifications.page");

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <NotificationsSettingsView />
    </>
  );
}
