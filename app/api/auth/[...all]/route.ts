import { NextRequest, NextResponse } from "next/server";
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";
import { env } from "@/server/env";
import { ApiError, Errors } from "@/server/http/errors";
import { limit, resolveClientIp } from "@/server/http/rate-limit";

const baseHandler = toNextJsHandler(auth);

async function readNormalizedEmail(req: NextRequest): Promise<string | null> {
  try {
    const cloned = req.clone();
    const body = (await cloned.json()) as { email?: unknown };
    if (typeof body?.email === "string") {
      const normalized = body.email.trim().toLowerCase();
      if (normalized.length > 0) return normalized;
    }
  } catch {
    // Ignore body parse errors here; Better Auth will handle payload validation
  }
  return null;
}

async function enforceAuthRateLimit(
  req: NextRequest,
  trustProxy: boolean = env.TRUST_PROXY
): Promise<void> {
  const pathname = req.nextUrl.pathname;
  const ip = resolveClientIp(req, trustProxy);

  if (pathname.endsWith("/sign-in/email")) {
    const email = await readNormalizedEmail(req);
    if (ip && email) {
      await limit("auth:signin", `${ip}:${email}`);
      return;
    }
    if (!ip && !trustProxy && email) {
      await limit("auth:signin", `email:${email}`);
      return;
    }
    if (ip && !email) {
      await limit("auth:signin", `ip:${ip}`);
      return;
    }
    throw Errors.rateLimited(60);
  }

  if (pathname.endsWith("/sign-up/email")) {
    if (ip) {
      await limit("auth:signup", `ip:${ip}`);
      return;
    }
    if (!trustProxy) {
      const email = await readNormalizedEmail(req);
      if (email) {
        await limit("auth:signup", `email:${email}`);
        return;
      }
    }
    // When TRUST_PROXY=true and the proxy IP header is missing/invalid,
    // or when neither IP nor email is available, fail closed.
    throw Errors.rateLimited(60);
  }

  if (
    pathname.endsWith("/forget-password") ||
    pathname.endsWith("/request-password-reset")
  ) {
    const email = await readNormalizedEmail(req);
    if (email) {
      await limit("auth:reset", `email:${email}`);
      return;
    }
    if (ip) {
      await limit("auth:reset", `ip:${ip}`);
      return;
    }
    throw Errors.rateLimited(60);
  }

  // Two-factor codes (sign-in challenge and setup): the plugin also limits
  // attempts per challenge and locks the account after repeated failures.
  if (pathname.endsWith("/two-factor/verify-totp") || pathname.endsWith("/two-factor/verify-backup-code")) {
    if (ip) {
      await limit("auth:2fa", `ip:${ip}`);
      return;
    }
    // Without a trusted proxy (local development) everyone shares one bucket.
    if (!trustProxy) {
      await limit("auth:2fa", "local");
      return;
    }
    throw Errors.rateLimited(60);
  }

  if (pathname.endsWith("/send-verification-email")) {
    const email = await readNormalizedEmail(req);
    if (email) {
      await limit("auth:verify", `email:${email}`);
      return;
    }
    if (ip) {
      await limit("auth:verify", `ip:${ip}`);
      return;
    }
    throw Errors.rateLimited(60);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const res = await baseHandler.GET(req);
  const xRetryAfter = res.headers.get("X-Retry-After");
  if (res.status === 429 && xRetryAfter && !res.headers.get("Retry-After")) {
    const headers = new Headers(res.headers);
    headers.set("Retry-After", xRetryAfter);
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}

/**
 * Two-factor management goes through /api/v1/me/two-factor/* (origin check,
 * audit log, security emails), never Better Auth's own endpoints from the
 * browser. Only the sign-in challenge (verify-totp / verify-backup-code) is open.
 */
const BLOCKED_TWO_FACTOR_PATHS = [
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
  "/two-factor/view-backup-codes",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/totp/generate",
];

function isBlockedTwoFactorPath(pathname: string) {
  return BLOCKED_TWO_FACTOR_PATHS.some((p) => pathname.endsWith(p));
}

export async function POST(req: NextRequest): Promise<Response> {
  if (isBlockedTwoFactorPath(req.nextUrl.pathname)) {
    return NextResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  }
  try {
    await enforceAuthRateLimit(req);
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      const retryAfter =
        err.details &&
        typeof err.details === "object" &&
        "retryAfter" in err.details &&
        typeof (err.details as { retryAfter?: unknown }).retryAfter === "number"
          ? (err.details as { retryAfter: number }).retryAfter
          : 60;
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        }
      );
    }
    throw err;
  }

  const res = await baseHandler.POST(req);
  const xRetryAfter = res.headers.get("X-Retry-After");
  if (res.status === 429 && xRetryAfter && !res.headers.get("Retry-After")) {
    const headers = new Headers(res.headers);
    headers.set("Retry-After", xRetryAfter);
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}
