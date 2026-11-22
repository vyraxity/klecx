import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { getUserPreferences } from "@/server/services/user-preferences";
import { ThemeCard } from "@/components/settings/appearance/theme-card";
import { BehaviorCard } from "@/components/settings/appearance/behavior-card";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.appearance");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Steps 9.1–9.2: Settings → Appearance (saved on the account). */
export default async function AppearanceSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations("Settings.appearance");
  const prefs = await getUserPreferences(actor.userId);
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <ThemeCard />
      <BehaviorCard
        userId={actor.userId}
        initialEnterToSend={prefs.enterToSend}
        initialReduceMotion={prefs.reduceMotion === true}
      />
    </>
  );
}
