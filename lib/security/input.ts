/**
 * Step 10.1 — input hygiene shared by `route()` (server/http/route.ts).
 */

/** JSON bodies larger than this are refused with 413 (uploads never carry the file). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

// C0 control characters except tab, line feed and carriage return, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Removes NUL and other invisible control characters; keeps \t, \n and \r. */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, "");
}

/**
 * Returns a copy of parsed JSON with control characters stripped from every
 * string (values and object keys), at any depth.
 */
export function sanitizeJsonStrings<T>(value: T): T {
  if (typeof value === "string") return stripControlChars(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeJsonStrings(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[stripControlChars(k)] = sanitizeJsonStrings(v);
    }
    return out as T;
  }
  return value;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF / origin check for cookie-authenticated requests (Step 10.1).
 * A mutating browser request must come from the app's own origin:
 * - `Authorization: Bearer …` requests (mobile apps, scripts) are exempt: a
 *   browser never adds that header by itself on another site's behalf;
 * - otherwise `Origin`, when present, must equal `APP_URL`'s origin, and
 *   `Sec-Fetch-Site`, when present, must be `same-origin`;
 * - a request with neither header doesn't come from a browser (browsers send
 *   `Origin` on every POST/PUT/PATCH/DELETE), so there is no cookie to abuse.
 * Session cookies are also `SameSite=Lax`, which already blocks most of this.
 */
export function isAllowedRequestOrigin(
  req: { method?: string; headers: { get(name: string): string | null } },
  appUrl: string
): boolean {
  if (!MUTATING_METHODS.has((req.method ?? "GET").toUpperCase())) return true;
  const authorization = req.headers.get("authorization");
  if (authorization && /^bearer\s+\S/i.test(authorization)) return true;

  let appOrigin: string;
  try {
    appOrigin = new URL(appUrl).origin;
  } catch {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (origin !== appOrigin) return false;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  return true;
}
