import "server-only";
import { createHash } from "node:crypto";

/**
 * Step 10.1 — refuse passwords that appear in known data breaches.
 *
 * Uses the public Pwned Passwords range API with k-anonymity: only the first
 * five characters of the password's SHA-1 hash leave the server, never the
 * password or its full hash, and the answer is padded so its size says nothing.
 *
 * Fails open: if the service is slow or down, the password is accepted (a
 * sign-up must never break because a third-party lookup failed).
 * Off in tests and when `PWNED_PASSWORD_CHECK=false`.
 */
export const PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 3000;

/** Better Auth paths that set a password, and the body field holding it. */
export const PASSWORD_SETTING_PATHS: Record<string, "password" | "newPassword"> = {
  "/sign-up/email": "password",
  "/reset-password": "newPassword",
  "/change-password": "newPassword",
  "/set-password": "newPassword",
};

export function isPwnedCheckEnabled(): boolean {
  if (process.env.PWNED_PASSWORD_CHECK === "false") return false;
  return process.env.NODE_ENV !== "test";
}

/** The breach count for `suffix` in a range response (0 when absent). */
export function countInRange(rangeBody: string, suffix: string): number {
  const wanted = suffix.toUpperCase();
  for (const line of rangeBody.split(/\r?\n/)) {
    const [hashSuffix, count] = line.trim().split(":");
    if (hashSuffix?.toUpperCase() === wanted) {
      const n = Number(count);
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    }
  }
  return 0;
}

/**
 * true = found in a breach, false = not found, null = couldn't check.
 * `fetchImpl` is injectable for tests.
 */
export async function isPasswordPwned(
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean | null> {
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetchImpl(`${PWNED_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "Klecx-password-check" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return countInRange(await res.text(), suffix) > 0;
  } catch {
    return null;
  }
}

/** Whether to refuse this password (enabled, and found in a breach). */
export async function shouldRefusePassword(
  password: unknown,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (!isPwnedCheckEnabled() || typeof password !== "string" || !password) return false;
  return (await isPasswordPwned(password, fetchImpl)) === true;
}
