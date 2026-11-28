/**
 * @jest-environment node
 */
/**
 * Pre-10.6 fix PR 2: proxy.ts keeps the readable `klecx_signed_in` hint in
 * step with the session cookie (marketing pages show "Go to your workspaces").
 */
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { SIGNED_IN_HINT_COOKIE } from "@/lib/auth/signed-in-hint-cookie";

describe("signed-in hint cookie (proxy)", () => {
  const APP = "http://localhost:3000";
  const SESSION = "better-auth.session_token=abc.def";

  const setCookie = (res: Response) => res.headers.get("set-cookie") ?? "";

  test("a session cookie sets the hint once; without a session it is cleared", async () => {
    const first = await proxy(new NextRequest(`${APP}/`, { headers: { cookie: SESSION } }));
    expect(setCookie(first)).toMatch(new RegExp(`${SIGNED_IN_HINT_COOKIE}=1`));
    expect(setCookie(first)).not.toMatch(/HttpOnly/i);

    const again = await proxy(
      new NextRequest(`${APP}/`, { headers: { cookie: `${SESSION}; ${SIGNED_IN_HINT_COOKIE}=1` } })
    );
    expect(setCookie(again)).not.toMatch(SIGNED_IN_HINT_COOKIE);

    const signedOut = await proxy(
      new NextRequest(`${APP}/pricing`, { headers: { cookie: `${SIGNED_IN_HINT_COOKIE}=1` } })
    );
    expect(setCookie(signedOut)).toMatch(new RegExp(`${SIGNED_IN_HINT_COOKIE}=;`));

    const anonymous = await proxy(new NextRequest(`${APP}/`));
    expect(setCookie(anonymous)).not.toMatch(SIGNED_IN_HINT_COOKIE);
  });

  test("an expired session link clears the hint with the session", async () => {
    const res = await proxy(
      new NextRequest(`${APP}/auth/login?reason=expired`, {
        headers: { cookie: `${SESSION}; ${SIGNED_IN_HINT_COOKIE}=1` },
      })
    );
    expect(setCookie(res)).toMatch(new RegExp(`${SIGNED_IN_HINT_COOKIE}=;`));
  });

});
