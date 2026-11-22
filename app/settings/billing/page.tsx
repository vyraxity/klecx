import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, CreditCard } from "lucide-react";
import { requireActor } from "@/server/auth/session";
import LocaleSwitcher from "@/components/layout/locale-switcher";
import AppName from "@/components/logo/AppName";
import Logo from "@/components/logo/Logo";
import { Button } from "@/components/ui/button";
import { BillingSettingsView } from "@/components/settings/billing/billing-settings-view";
import { parseSubscribeIntent } from "@/lib/billing/intent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Billing.page");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/** Step 8.5: Settings → Billing. */
export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const t = await getTranslations("Billing.page");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  return (
    <div className="min-h-screen w-full bg-bg text-fg flex flex-col">
      <header className="w-full border-b border-border bg-surface/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between">
          <Link href="/workspaces" className="flex items-center gap-2">
            <Logo size="icon" />
            <AppName />
          </Link>
          <div className="flex items-center gap-3">
            <LocaleSwitcher />
            <Button asChild variant="outline" size="sm">
              <Link href="/settings" className="flex items-center gap-1.5">
                <ArrowLeft className="w-3.5 h-3.5" />
                {t("back")}
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-accent font-semibold text-xs tracking-wider uppercase">
            <CreditCard className="w-4 h-4" />
            {t("eyebrow")}
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">{t("title")}</h1>
          <p className="text-xs sm:text-sm text-muted">{t("description")}</p>
        </div>

        <BillingSettingsView
          userId={actor.userId}
          checkoutReturned={one(params.checkout) === "success"}
          intent={parseSubscribeIntent(one(params.subscribe), one(params.interval))}
        />
      </main>
    </div>
  );
}
