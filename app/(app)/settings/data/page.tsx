import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { YourDataSettings } from "@/components/settings/data/your-data-settings";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.data");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Step 9.5: Settings → Your data (export, account deletion). */
export default async function YourDataPage() {
  const actor = await requireActor();
  const t = await getTranslations("Settings.data");
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <YourDataSettings userId={actor.userId} />
    </>
  );
}
