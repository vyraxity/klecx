import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ChevronRight, Laptop } from "lucide-react";
import { requireActor } from "@/server/auth/session";
import { listLinkedAccounts } from "@/server/services/account-security";
import { getAccountIdentity } from "@/server/services/user-profile";
import { PasswordCard } from "@/components/settings/security/password-card";
import { LinkedAccountsCard } from "@/components/settings/security/linked-accounts-card";
import { TwoFactorCard } from "@/components/settings/security/two-factor-card";
import { getTwoFactorStatus } from "@/server/services/two-factor";
import { SettingsPageHeader, SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.security");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** Step 9.1: Settings → Security (two-factor sign-in since after Step 10.1). */
export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const t = await getTranslations("Settings.security");
  const [linked, identity, twoFactor, params] = await Promise.all([
    listLinkedAccounts(actor.userId),
    getAccountIdentity(actor.userId),
    getTwoFactorStatus(actor.userId),
    searchParams,
  ]);

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <PasswordCard hasPassword={linked.hasPassword} email={identity.email} />
      <TwoFactorCard initial={twoFactor} />
      <LinkedAccountsCard userId={actor.userId} linkError={params.linkError === "1" || typeof params.error === "string"} />
      <SettingsSection title={t("sessionsTitle")} description={t("sessionsHint")}>
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/sessions" className="gap-2">
              <Laptop className="h-4 w-4" aria-hidden />
              {t("sessionsLink")}
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}
