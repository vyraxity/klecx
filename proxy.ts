import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { SIGNED_IN_HINT_COOKIE, syncSignedInHint } from "@/lib/auth/signed-in-hint-cookie";
import {
  authRoutes,
  DEFAULT_LOGIN_REDIRECT,
  isMetadataImageRoute,
  publicRoutes,
} from "./utils/routes";
import {
  buildCsp,
  createNonce,
  cspHeaderName,
  reportingEndpointsHeader,
} from "./lib/security/csp";

/**
 * Step 10.1: every page gets a Content-Security-Policy with a fresh nonce.
 * The request carries it too (`x-nonce` and the CSP header), so Next.js and
 * `app/layout.tsx` can put the nonce on their inline scripts.
 * `CSP_REPORT_ONLY=true` turns enforcement into report-only (a switch, no code change).
 */
type Csp = { nonce: string; header: string; value: string; requestHeaders: Headers };

function prepareCsp(req: NextRequest): Csp | null {
  // API responses are JSON/SSE/files, never HTML pages.
  if (req.nextUrl.pathname.startsWith("/api/")) return null;
  const nonce = createNonce();
  const value = buildCsp(nonce, { dev: process.env.NODE_ENV === "development" });
  const header = cspHeaderName(process.env.CSP_REPORT_ONLY === "true");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(header, value);
  return { nonce, header, value, requestHeaders };
}

function nextWith(csp: Csp | null) {
  return csp
    ? NextResponse.next({ request: { headers: csp.requestHeaders } })
    : NextResponse.next();
}

function attachCsp(res: NextResponse, csp: Csp | null) {
  if (!csp) return res;
  res.headers.set(csp.header, csp.value);
  res.headers.set("Reporting-Endpoints", reportingEndpointsHeader());
  return res;
}

function attachSecurityHeaders(res: NextResponse, pathname: string) {
  if (pathname.startsWith("/s/") || pathname.startsWith("/api/v1/s/")) {
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  }

  const isPrivateRoute =
    pathname.startsWith("/workspaces") ||
    pathname.startsWith("/projects") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/api/");

  if (isPrivateRoute) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

/** Sign-in pages a signed-in person may still open (links from their emails). */
const OPEN_WHEN_SIGNED_IN = new Set(["/auth/reset-password", "/reset-password"]);

export function clearAuthCookies(res: NextResponse) {
  const cookieNames = [
    "better-auth.session_token",
    "__Secure-better-auth.session_token",
    "better-auth.session_data",
    "__Secure-better-auth.session_data",
    "better-auth.dont_remember",
    "__Secure-better-auth.dont_remember",
  ];
  for (const name of cookieNames) {
    res.cookies.delete(name);
    res.cookies.set(name, "", {
      maxAge: 0,
      path: "/",
      expires: new Date(0),
    });
  }
}

export async function proxy(req: NextRequest) {
  const csp = prepareCsp(req);
  return attachCsp(await handle(req, csp), csp);
}

async function handle(req: NextRequest, csp: Csp | null): Promise<NextResponse> {
  const { nextUrl } = req;
  const { pathname } = nextUrl;

  // Maintenance mode handling (Step 4.3)
  if (process.env.MAINTENANCE_MODE === "true") {
    if (
      pathname !== "/maintenance" &&
      pathname !== "/status" &&
      !pathname.startsWith("/api/health") &&
      !pathname.startsWith("/api/ready")
    ) {
      return attachSecurityHeaders(
        NextResponse.redirect(new URL("/maintenance", nextUrl)),
        pathname,
      );
    }
    return attachSecurityHeaders(nextWith(csp), pathname);
  }

  // Leave Better Auth, webhooks, cron jobs, and shared links public
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/cron") ||
    // Step 10.2: browser error reports relayed to Sentry (no session needed).
    pathname === "/sentry-tunnel" ||
    pathname.startsWith("/s/")
  ) {
    return attachSecurityHeaders(nextWith(csp), pathname);
  }

  // API routes handle their own authorization via route() / getActor()
  if (pathname.startsWith("/api/")) {
    return attachSecurityHeaders(nextWith(csp), pathname);
  }

  const sessionCookie = getSessionCookie(req);
  const isLoggedIn = Boolean(sessionCookie);

  const isPublicRoute =
    publicRoutes.includes(pathname) ||
    isMetadataImageRoute(pathname) ||
    pathname.startsWith("/help/") ||
    pathname === "/maintenance";

  const isAuthRoute = authRoutes.includes(pathname);

  // Pre-10.6 fix: a readable hint so marketing pages can offer "Go to your
  // workspaces" without a server-side session check. Cleared with the session.
  const hasHint = req.cookies.get(SIGNED_IN_HINT_COOKIE)?.value === "1";
  const secureCookie = nextUrl.protocol === "https:";
  const finish = (res: NextResponse, signedIn = isLoggedIn) =>
    attachSecurityHeaders(syncSignedInHint(res, hasHint, signedIn, secureCookie), pathname);

  const hasExpiredReason =
    nextUrl.searchParams.get("reason") === "expired" ||
    nextUrl.searchParams.get("reason") === "revoked" ||
    nextUrl.searchParams.get("reason") === "account_deleted" ||
    nextUrl.searchParams.has("expired") ||
    nextUrl.searchParams.has("revoked");

  // Canonical alias: forward /login to /auth/login
  if (pathname === "/login") {
    const url = new URL("/auth/login", nextUrl);
    url.search = nextUrl.search;
    const res = NextResponse.redirect(url);
    if (hasExpiredReason) {
      clearAuthCookies(res);
    }
    return finish(res, isLoggedIn && !hasExpiredReason);
  }

  if (isAuthRoute) {
    // If arriving with an expired or revoked reason, clear stale session cookies and show login
    if (hasExpiredReason) {
      const res = nextWith(csp);
      clearAuthCookies(res);
      return finish(res, false);
    }

    // Pre-10.6 fix: a password-reset link opens even when signed in (it was
    // sent to this person; sending them to the dashboard lost the link).
    if (isLoggedIn && !OPEN_WHEN_SIGNED_IN.has(pathname)) {
      return finish(NextResponse.redirect(new URL(DEFAULT_LOGIN_REDIRECT, nextUrl)));
    }
    return finish(nextWith(csp));
  }

  if (!isLoggedIn && !isPublicRoute) {
    return finish(NextResponse.redirect(new URL("/auth/login", nextUrl)));
  }

  return finish(nextWith(csp));
}

export default proxy;

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};
