import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { ThemeCard } from "@/components/settings/appearance/theme-card";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.appearance");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/**
 * Step 9.1: Settings → Appearance. Enter-to-send and reduced motion need the
 * preference fields of Step 9.2 and are added there.
 */
export default async function AppearanceSettingsPage() {
  await requireActor();
  const t = await getTranslations("Settings.appearance");
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <ThemeCard />
    </>
  );
}
