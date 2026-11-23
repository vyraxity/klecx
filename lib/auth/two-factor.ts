/**
 * Two-factor sign-in (after Step 10.1): shared constants and helpers for the
 * sign-in challenge, Settings → Security and the server.
 */

/** "Trust this device" lasts this many days (the server's trustDeviceMaxAge). */
export const TWO_FACTOR_TRUST_DAYS = 30;

/** Authenticator-app codes are 6 digits. */
export const TOTP_CODE_LENGTH = 6;

/** The sign-in challenge page. */
export const TWO_FACTOR_CHALLENGE_PATH = "/auth/two-factor";

/** Keeps digits only, at most 6 (people paste "123 456"). */
export function normalizeTotpCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, TOTP_CODE_LENGTH);
}

/** Backup codes look like "AbCdE-12345"; spaces are ignored. */
export function normalizeBackupCode(raw: string): string {
  return raw.replace(/\s+/g, "").slice(0, 64);
}

/**
 * The secret in an otpauth:// URI, grouped in fours for typing by hand
 * ("ABCD EFGH …"). Empty when the URI can't be read.
 */
export function manualEntryKey(totpUri: string): string {
  try {
    const secret = new URL(totpUri).searchParams.get("secret") ?? "";
    return secret.replace(/(.{4})/g, "$1 ").trim();
  } catch {
    return "";
  }
}

/**
 * Where to go after the challenge: only a path on this site (never another
 * origin, never `//host`), else the default.
 */
export function safeNextPath(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
