import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { SessionsList } from "@/components/settings/SessionsList";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata.settings");
  return {
    title: t("sessionsTitle"),
    description: t("sessionsDescription"),
    robots: { index: false, follow: false },
  };
}

/** Step 7.3, moved under the Settings shell in Step 9.1. */
export default async function SessionsPage() {
  await requireActor();
  const t = await getTranslations("Settings.sessions");

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("subtitle")} />
      <div className="w-full rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-6">
        <SessionsList />
      </div>
    </>
  );
}
