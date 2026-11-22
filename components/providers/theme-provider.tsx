"use client";

import * as React from "react";
import {
  LEGACY_THEME_STORAGE_KEY,
  THEMES,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  parseTheme,
  type ResolvedTheme,
  type Theme,
} from "@/lib/theme";

/**
 * Step 9.2: Klecx's own theme provider (replaces next-themes, whose inline
 * <script> inside the React tree made React 19 warn on every page).
 *
 * - The server renders <html data-theme-pref data-theme> from the account's
 *   theme (signed in) or the `theme` cookie, and `THEME_INIT_SCRIPT` in
 *   <head> resolves "system" before paint, so there's no flash.
 * - `setTheme()` updates the page and the cookie at once and, when signed
 *   in, saves the choice on the account (best effort) so other devices pick
 *   it up on their next load.
 */
interface ThemeContextValue {
  /** The chosen theme. */
  theme: Theme;
  /** What is shown; undefined until the browser has resolved it (as with next-themes). */
  resolvedTheme: ResolvedTheme | undefined;
  setTheme: (theme: Theme) => void;
  themes: readonly Theme[];
}

const ThemeContext = React.createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: undefined,
  setTheme: () => {},
  themes: THEMES,
});

export function useTheme(): ThemeContextValue {
  return React.useContext(ThemeContext);
}

function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function writeThemeCookie(theme: Theme) {
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/** Applies a theme to <html> without animating every colour change. */
function applyTheme(theme: Theme): ResolvedTheme {
  const root = document.documentElement;
  const resolved = theme === "system" ? systemTheme() : theme;
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  root.setAttribute("data-theme-pref", theme);
  root.setAttribute("data-theme", resolved);
  // Force a style flush, then let transitions back in.
  void window.getComputedStyle(document.body).opacity;
  window.setTimeout(() => style.remove(), 0);
  return resolved;
}

export function ThemeProvider({
  initialTheme,
  cookieTheme,
  saveToAccount,
  children,
}: {
  /** The theme the server rendered (account, else cookie); null when neither exists. */
  initialTheme: Theme | null;
  /** The device's cookie as the server saw it. */
  cookieTheme: Theme | null;
  /** Signed in: also save changes on the account. */
  saveToAccount: boolean;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = React.useState<Theme>(initialTheme ?? "system");
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme | undefined>(undefined);

  // After hydration: read what the head script resolved, keep the cookie in
  // line with the account, and move an older next-themes choice to the cookie.
  React.useEffect(() => {
    const root = document.documentElement;
    const pref = parseTheme(root.getAttribute("data-theme-pref")) ?? "system";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the DOM the head script prepared
    setThemeState(pref);
    setResolvedTheme(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
    if (pref !== cookieTheme) writeThemeCookie(pref);
    try {
      localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    } catch {
      // Storage blocked: nothing to clean up.
    }
  }, [cookieTheme]);

  // "System" follows the device when it switches between light and dark.
  React.useEffect(() => {
    if (theme !== "system") return;
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = () => setResolvedTheme(applyTheme("system"));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = React.useCallback(
    (next: Theme) => {
      if (!parseTheme(next)) return;
      setThemeState(next);
      setResolvedTheme(applyTheme(next));
      writeThemeCookie(next);
      if (saveToAccount) {
        void fetch("/api/v1/me/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: next }),
        }).catch(() => undefined);
      }
    },
    [saveToAccount]
  );

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme, themes: THEMES }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
