import type { NextResponse } from "next/server";

/** Readable (not httpOnly) cookie: "1" while a session cookie exists. Not a credential. */
export const SIGNED_IN_HINT_COOKIE = "klecx_signed_in";

/** Matches the longest session ("remember me"); the proxy renews or clears it anyway. */
const HINT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Sets the hint when a session cookie is present and clears it when not.
 * Writes only when it changes, so most responses carry no Set-Cookie.
 */
export function syncSignedInHint(
  res: NextResponse,
  hasHint: boolean,
  signedIn: boolean,
  secure: boolean
): NextResponse {
  if (signedIn && !hasHint) {
    res.cookies.set(SIGNED_IN_HINT_COOKIE, "1", {
      path: "/",
      sameSite: "lax",
      secure,
      httpOnly: false,
      maxAge: HINT_MAX_AGE_SECONDS,
    });
  } else if (!signedIn && hasHint) {
    res.cookies.set(SIGNED_IN_HINT_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return res;
}
