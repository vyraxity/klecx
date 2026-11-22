import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { UsageView } from "@/components/settings/usage/usage-view";
import { SettingsPageHeader } from "@/components/settings/settings-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Usage");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Step 9.3: Settings → Usage (where the credits went). */
export default async function UsageSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations("Usage");
  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <UsageView userId={actor.userId} />
    </>
  );
}
