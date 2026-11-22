/**
 * Step 9.2: theme preference. The device keeps it in the `theme` cookie (read
 * by app/layout.tsx so the first HTML already has the right colours); a
 * signed-in person's choice is also saved on the account
 * (`UserPreference.theme`), which wins on every device.
 */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_COOKIE = "theme";
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** The key next-themes used before Step 9.2; read once to keep a device's old choice. */
export const LEGACY_THEME_STORAGE_KEY = "theme";

export function parseTheme(value: unknown): Theme | null {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as Theme)
    : null;
}

/** `data-theme` for the server-rendered <html>: undefined for "system" (the head script resolves it). */
export function serverThemeAttribute(theme: Theme): ResolvedTheme | undefined {
  return theme === "system" ? undefined : theme;
}

/**
 * Runs in <head> before the page paints: resolves "system" with the device's
 * colour scheme, and keeps an older next-themes choice from localStorage when
 * no cookie exists yet. Kept tiny and dependency-free.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement,p=d.getAttribute("data-theme-pref");if(!p){var l=localStorage.getItem("${LEGACY_THEME_STORAGE_KEY}");p=(l==="light"||l==="dark"||l==="system")?l:"system";d.setAttribute("data-theme-pref",p);}var t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;d.setAttribute("data-theme",t);}catch(e){}})();`;

/** Step 9.2: spacing density. "compact" tightens spacing from tablet width up (app/globals.css). */
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];
