/**
 * Step 9.1: the Settings pages, in nav order. Voice (9.4), Usage (9.3) and
 * Your data (9.5) are added by their own steps, so the nav never shows a page
 * that doesn't work yet.
 */
export const SETTINGS_PAGES = [
  "profile",
  "security",
  "sessions",
  "language",
  "appearance",
  "notifications",
  "billing",
  "support",
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number];

export const SETTINGS_HOME = "/settings/profile";

export function settingsHref(page: SettingsPage): string {
  return `/settings/${page}`;
}

/** The page a pathname belongs to (`/settings/billing?x` → `billing`), or null. */
export function activeSettingsPage(pathname: string | null | undefined): SettingsPage | null {
  const match = pathname?.match(/^\/settings\/([^/?#]+)/);
  const page = match?.[1];
  return page && (SETTINGS_PAGES as readonly string[]).includes(page) ? (page as SettingsPage) : null;
}
