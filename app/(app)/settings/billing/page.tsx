import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/server/auth/session";
import { BillingSettingsView } from "@/components/settings/billing/billing-settings-view";
import { SettingsPageHeader } from "@/components/settings/settings-section";
import CreditsCard from "@/components/home/credits-card";
import { getHomeCredits } from "@/server/services/home";
import { parseSubscribeIntent } from "@/lib/billing/intent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Billing.page");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/** Step 8.5: Settings → Plan & billing (inside the Settings shell since Step 9.1). */
export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const t = await getTranslations("Billing.page");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const credits = await getHomeCredits(actor.userId).catch(() => null);

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      {credits && <CreditsCard credits={credits} showPlanAction={false} />}
      <BillingSettingsView
        userId={actor.userId}
        checkoutReturned={one(params.checkout) === "success"}
        intent={parseSubscribeIntent(one(params.subscribe), one(params.interval))}
      />
    </>
  );
}
