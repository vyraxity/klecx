/**
 * The app version shown in Settings → Support and sent with support
 * diagnostics (`package.json`'s version, inlined by next.config.mjs).
 */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

/** The deployed commit, when the host exposes it (Vercel: system env vars). */
export const APP_BUILD: string | null =
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null;

export interface ClientDiagnostics {
  appVersion: string;
  build: string | null;
  clientTimestamp: string;
  userAgent: string;
  language: string;
  screen: string;
  timeZone: string;
  hasActiveSession: boolean;
}

/**
 * Non-sensitive browser details for support (F5.8 / Step 9.1): no content,
 * no identifiers beyond what the person sends themselves.
 */
export function collectClientDiagnostics(hasActiveSession: boolean): ClientDiagnostics {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  let timeZone = "unknown";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    // Older browsers.
  }
  return {
    appVersion: APP_VERSION,
    build: APP_BUILD,
    clientTimestamp: new Date().toISOString(),
    userAgent: nav?.userAgent ?? "unknown",
    language: nav?.language ?? "unknown",
    screen: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "unknown",
    timeZone,
    hasActiveSession,
  };
}
