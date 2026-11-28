/**
 * Step 9.1: the Settings pages, in nav order (Usage since Step 9.3, Voice
 * since 9.4, Your data since 9.5). A page is added by the step that builds
 * it, so the nav never shows a page that doesn't work yet.
 */
export const SETTINGS_PAGES = [
  "profile",
  "security",
  "sessions",
  "language",
  "appearance",
  "voice",
  "notifications",
  "usage",
  "billing",
  "data",
  // Pre-10.6 fix: deleted workspaces and projects, restorable for 30 days.
  "deleted",
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
