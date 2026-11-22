import type { ReactNode } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SettingsNav } from "@/components/settings/settings-nav";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata.settings");
  return {
    title: t("title"),
    description: t("description"),
    robots: { index: false, follow: false },
  };
}

/**
 * Step 9.1: the Settings area inside the app shell. Left nav from `md` up,
 * scrollable tabs above the page below it; the page scrolls on its own.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row md:gap-8 md:py-10">
        <SettingsNav />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}
