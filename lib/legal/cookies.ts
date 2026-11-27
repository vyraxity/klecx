/**
 * Every cookie and browser-storage item Klecx sets (F5.5). The Cookie Policy
 * renders its table from this list.
 * A test checks that each name is still used in the code, so the policy can't
 * list something that no longer exists.
 *
 * When you add a cookie or a storage key: add it here (and its purpose in
 * `Legal.cookies.purposes` in en/es/fr). A non-essential cookie (analytics,
 * marketing) also needs a consent banner first; see F5.6.
 */

export type StorageKind = "cookie" | "localStorage" | "sessionStorage";
export type StorageCategory = "essential" | "preference";

export interface StorageItem {
  /** Names as they appear in the browser (one row per item). */
  names: string[];
  kind: StorageKind;
  category: StorageCategory;
  /** `Legal.cookies.purposes.<purpose>` */
  purpose: string;
  /** `Legal.cookies.durations.<duration>` */
  duration: string;
}

export const STORAGE_ITEMS: StorageItem[] = [
  {
    // Better Auth; the __Secure- prefix is used on HTTPS.
    names: ["better-auth.session_token", "__Secure-better-auth.session_token"],
    kind: "cookie",
    category: "essential",
    purpose: "session",
    duration: "sessionRolling",
  },
  // Pre-10.6 fix: "1" while signed in, so public pages can show "Go to your
  // workspaces" (lib/auth/signed-in-hint-cookie.ts, set by proxy.ts).
  { names: ["klecx_signed_in"], kind: "cookie", category: "essential", purpose: "signedInHint", duration: "sessionRolling" },
  // F5.6: set by Accept on the cookie notice (lib/cookie-notice.ts).
  { names: ["klecx_cookie_notice"], kind: "cookie", category: "essential", purpose: "cookieNotice", duration: "oneYear" },
  { names: ["NEXT_LOCALE"], kind: "cookie", category: "preference", purpose: "locale", duration: "oneYear" },
  // Step 9.2: the answer to the "also available in …" banner (lib/i18n/locale-suggestion.ts).
  { names: ["klecx_locale_suggestion"], kind: "cookie", category: "preference", purpose: "localeSuggestion", duration: "oneYear" },
  { names: ["sidebar"], kind: "cookie", category: "preference", purpose: "sidebar", duration: "oneYear" },
  // Step 9.2: the theme is a cookie (read by the server, so pages render in the
  // right colours at once); it was in localStorage before (lib/theme.ts).
  { names: ["theme"], kind: "cookie", category: "preference", purpose: "theme", duration: "oneYear" },
  { names: ["klecx-ui-store"], kind: "localStorage", category: "preference", purpose: "uiStore", duration: "untilCleared" },
  {
    names: ["klecx-panel-width", "klecx-ask-col-width", "klecx-doc-col-width"],
    kind: "localStorage",
    category: "preference",
    purpose: "columnWidths",
    duration: "untilCleared",
  },
  { names: ["klecx-sidebar-pinned"], kind: "localStorage", category: "preference", purpose: "sidebarPinned", duration: "untilCleared" },
  { names: ["klecx-project-view-mode"], kind: "localStorage", category: "preference", purpose: "projectView", duration: "untilCleared" },
  { names: ["klecx-document-drafts-v1"], kind: "sessionStorage", category: "preference", purpose: "documentDrafts", duration: "tab" },
  { names: ["klecx_username_prompted"], kind: "sessionStorage", category: "preference", purpose: "usernamePrompt", duration: "tab" },
];
