"use client";

import * as React from "react";

/**
 * Pre-10.6 fix (owner, 2026-11-27): the marketing pages show "Go to your
 * workspaces" instead of Sign in / Get started to a signed-in visitor.
 *
 * The session cookie is httpOnly and checking the session on the server would
 * make every marketing page depend on the visitor (Step 10.7 caches them), so
 * `proxy.ts` keeps a readable hint cookie in step with the presence of a
 * session cookie (`syncSignedInHint` in `lib/auth/signed-in-hint-cookie.ts`)
 * and the page reads it after hydration. Crawlers and signed-out visitors get
 * the normal buttons; a stale hint only leads to the sign-in page.
 */
import { SIGNED_IN_HINT_COOKIE } from "@/lib/auth/signed-in-hint-cookie";

function readHint(): boolean {
  try {
    return document.cookie
      .split(";")
      .some((part) => part.trim() === `${SIGNED_IN_HINT_COOKIE}=1`);
  } catch {
    return false;
  }
}

const subscribe = () => () => {};

/** True in the browser when the proxy saw a session; false on the server. */
export function useSignedInHint(): boolean {
  return React.useSyncExternalStore(subscribe, readHint, () => false);
}
