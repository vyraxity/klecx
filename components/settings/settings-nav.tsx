"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  BarChart3,
  Bell,
  CreditCard,
  Database,
  Languages,
  Laptop,
  LifeBuoy,
  Palette,
  Shield,
  User,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/lib/stores/ui";
import {
  SETTINGS_PAGES,
  activeSettingsPage,
  settingsHref,
  type SettingsPage,
} from "@/lib/settings/nav";

const ICONS: Record<SettingsPage, LucideIcon> = {
  profile: User,
  security: Shield,
  sessions: Laptop,
  language: Languages,
  appearance: Palette,
  voice: Volume2,
  notifications: Bell,
  usage: BarChart3,
  billing: CreditCard,
  data: Database,
  support: LifeBuoy,
};

/**
 * Step 9.1: Settings navigation. A vertical list from `md` up; below it a row
 * of tabs that scrolls sideways (the active one is scrolled into view).
 */
export function SettingsNav() {
  const t = useTranslations("Settings.nav");
  const pathname = usePathname();
  const active = activeSettingsPage(pathname);
  const setCurrentPageTitle = useUiStore((s) => s.setCurrentPageTitle);
  const activeRef = React.useRef<HTMLAnchorElement | null>(null);

  // The top bar shows "Settings" instead of the last workspace's title.
  React.useEffect(() => {
    setCurrentPageTitle(t("title"));
    return () => setCurrentPageTitle("");
  }, [setCurrentPageTitle, t]);

  React.useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [active]);

  return (
    // Desktop: stays at the top of the settings scroll area while a long page
    // scrolls (top-10 matches the layout's md:py-10). Mobile: tabs above the page.
    <nav
      aria-label={t("label")}
      className="md:sticky md:top-10 md:max-h-[calc(100dvh-10rem)] md:w-52 md:shrink-0 md:self-start md:overflow-y-auto"
    >
      <ul
        className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0"
        data-testid="settings-nav"
      >
        {SETTINGS_PAGES.map((page) => {
          const Icon = ICONS[page];
          const isActive = page === active;
          return (
            <li key={page} className="shrink-0">
              <Link
                ref={isActive ? activeRef : undefined}
                href={settingsHref(page)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  isActive
                    ? "bg-accent/10 text-accent"
                    : "text-muted hover:bg-surface-2 hover:text-fg"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
                {t(page)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
