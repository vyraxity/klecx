import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { VoiceSettings } from "@/components/settings/voice/voice-settings";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.voice");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Step 9.4: Settings → Voice (read-aloud voice, speed, previews). */
export default async function VoiceSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations("Settings.voice");
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <VoiceSettings userId={actor.userId} />
    </>
  );
}
