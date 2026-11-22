import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { BookOpen, ChevronRight, MessageSquare } from "lucide-react";
import { requireActor } from "@/server/auth/session";
import { getArticle } from "@/lib/help/articles";
import { MyTicketsCard } from "@/components/settings/support/my-tickets-card";
import { DiagnosticsCard } from "@/components/settings/support/diagnostics-card";
import { SettingsPageHeader, SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Settings.support");
  return { title: t("title"), robots: { index: false, follow: false } };
}

const HELP_SLUGS = ["getting-started", "account-and-security", "credits-and-plans", "troubleshooting"];

/** Step 9.1: Settings → Support. */
export default async function SupportSettingsPage() {
  const actor = await requireActor();
  const t = await getTranslations("Settings.support");
  const locale = await getLocale();
  const articles = HELP_SLUGS.map((slug) => getArticle(locale, slug)).filter(
    (a): a is NonNullable<typeof a> => a !== null
  );

  return (
    <>
      <SettingsPageHeader title={t("title")} description={t("description")} />

      <SettingsSection title={t("helpTitle")} description={t("helpHint")}>
        <ul className="flex flex-col gap-1">
          {articles.map((a) => (
            <li key={a.slug}>
              <Link
                href={`/help/${a.slug}`}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm text-fg hover:bg-surface-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <BookOpen className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                  <span className="truncate">{a.title}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/help">{t("allArticles")}</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/support" className="gap-2">
              <MessageSquare className="h-4 w-4" aria-hidden />
              {t("contact")}
            </Link>
          </Button>
        </div>
      </SettingsSection>

      <MyTicketsCard userId={actor.userId} />
      <DiagnosticsCard />
    </>
  );
}
