import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { getUserPreferences } from "@/server/services/user-preferences";
import { AppLanguageCard } from "@/components/settings/language/app-language-card";
import AiPreferences from "@/components/settings/AiPreferences";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.language");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/**
 * Step 9.1: Settings → Language & AI. The app language, the language Klecx
 * answers in (Auto = match my message), web search (F4.1/F4.2) and the
 * default model for new messages (pre-10.6 fix).
 */
export default async function LanguageSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations("Settings.language");
  const prefs = await getUserPreferences(actor.userId);

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <AppLanguageCard userId={actor.userId} initialUiLocale={prefs.uiLocale} />
      <AiPreferences
        userId={actor.userId}
        initialWebSearchEnabled={prefs.webSearchEnabled}
        initialAiLanguage={prefs.aiLanguage}
        initialDefaultModelKey={prefs.defaultModelKey}
      />
    </>
  );
}
