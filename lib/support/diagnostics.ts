export interface AppVersionInfo {
  version: string;
  build: string | null;
}

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
 * no identifiers beyond what the person sends themselves. The version comes
 * from the server (`getAppVersionInfo()`).
 */
export function collectClientDiagnostics(
  hasActiveSession: boolean,
  app: AppVersionInfo
): ClientDiagnostics {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  let timeZone = "unknown";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    // Older browsers.
  }
  return {
    appVersion: app.version,
    build: app.build,
    clientTimestamp: new Date().toISOString(),
    userAgent: nav?.userAgent ?? "unknown",
    language: nav?.language ?? "unknown",
    screen: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "unknown",
    timeZone,
    hasActiveSession,
  };
}
