import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { z, ZodTypeAny } from "zod";
import { ApiError, Errors } from "./errors";
import { limit, type RateLimitPolicy } from "./rate-limit";
import { getActor, type Actor } from "@/server/auth/session";
import { env } from "@/server/env";
import { log, errInfo } from "@/server/log";
import { captureServerError } from "@/server/monitoring/sentry";
import {
  MAX_JSON_BODY_BYTES,
  isAllowedRequestOrigin,
  sanitizeJsonStrings,
} from "@/lib/security/input";

export type Ctx<B, Q, P> = {
  req: NextRequest;
  actor: Actor;
  body: B;
  query: Q;
  params: P;
  requestId: string;
};

export function clearResponseAuthCookies(res: NextResponse) {
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

/** Requests slower than this are logged as warnings (streams log when they start answering). */
const SLOW_REQUEST_MS = 10_000;

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/api/v1/workspaces/0196…/members/u_12` → `/api/v1/workspaces/:id/members/:id`. */
export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((seg, i, all) => {
      if (!seg || i < 3) return seg;
      if (UUIDISH.test(seg) || /\d/.test(seg) || (seg.length > 20 && /^[\w-]+$/.test(seg))) return ":id";
      return all[i - 1] === "linked-accounts" || all[i - 1] === "s" ? ":id" : seg;
    })
    .join("/");
}

function payloadTooLarge() {
  return new ApiError(413, "payload_too_large", "Request body is too large", {
    maxBytes: MAX_JSON_BODY_BYTES,
  });
}

export function route<
  B extends ZodTypeAny = z.ZodUndefined,
  Q extends ZodTypeAny = z.ZodUndefined,
  P = Record<string, string>,
>(opts: {
  auth?: "required" | "optional"; // default "required"
  disableCookieCache?: boolean;
  body?: B;
  query?: Q;
  rateLimit?: {
    policy: RateLimitPolicy;
    key: (c: Ctx<z.infer<B>, z.infer<Q>, P>) => string;
  };
  handler: (c: Ctx<z.infer<B>, z.infer<Q>, P>) => Promise<unknown | Response>;
}) {
  return async (
    req: NextRequest,
    context?: { params?: Promise<P> | P }
  ): Promise<Response> => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const started = Date.now();
    // Step 10.2: the path pattern, not the URL (ids and query strings stay out of the logs).
    const path = routePattern(req.nextUrl.pathname);
    let userId: string | undefined;
    const done = (res: Response) => {
      const ms = Date.now() - started;
      const line = { requestId, method: req.method, path, status: res.status, ms, ...(userId ? { userId } : {}) };
      if (res.status >= 500) log.error(line, "request failed");
      else if (ms > SLOW_REQUEST_MS) log.warn(line, "slow request");
      else log.info(line, "request");
      return res;
    };
    try {
      // Step 10.1: a cookie-authenticated change must come from our own origin.
      if (!isAllowedRequestOrigin(req, env.APP_URL)) {
        throw Errors.forbidden("Cross-site request refused", "origin_mismatch");
      }

      const actor = await getActor(req, { disableCookieCache: opts.disableCookieCache }); // session cookie OR Bearer token
      userId = actor?.userId;
      if ((opts.auth ?? "required") === "required" && !actor) {
        throw Errors.unauthorized();
      }

      let parsedBody: z.infer<B> = undefined as z.infer<B>;
      if (opts.body) {
        let rawJson: unknown = {};
        // Step 10.1: JSON bodies are capped at 1 MB (uploads never carry the file).
        const declared = Number(req.headers.get("content-length") ?? "0");
        if (declared > MAX_JSON_BODY_BYTES) throw payloadTooLarge();
        if (typeof req.text === "function") {
          const rawText = await req.text();
          if (Buffer.byteLength(rawText, "utf8") > MAX_JSON_BODY_BYTES) {
            throw payloadTooLarge();
          }
          if (rawText.trim().length > 0) {
            try {
              rawJson = JSON.parse(rawText);
            } catch {
              throw Errors.badRequest("Malformed JSON");
            }
          }
        } else {
          rawJson = await req.json().catch(() => ({}));
        }
        // NUL and other control characters never reach a service.
        const bodyResult = opts.body.safeParse(sanitizeJsonStrings(rawJson));
        if (!bodyResult.success) {
          throw Errors.validation(bodyResult.error.flatten());
        }
        parsedBody = bodyResult.data as z.infer<B>;
      }

      let parsedQuery: z.infer<Q> = undefined as z.infer<Q>;
      if (opts.query) {
        const rawQuery = sanitizeJsonStrings(
          Object.fromEntries(req.nextUrl.searchParams)
        );
        const queryResult = opts.query.safeParse(rawQuery);
        if (!queryResult.success) {
          throw Errors.validation(queryResult.error.flatten());
        }
        parsedQuery = queryResult.data as z.infer<Q>;
      }

      const resolvedParams = context?.params
        ? await context.params
        : ({} as P);

      const ctx: Ctx<z.infer<B>, z.infer<Q>, P> = {
        req,
        actor: actor as Actor,
        body: parsedBody,
        query: parsedQuery,
        params: resolvedParams,
        requestId,
      };

      if (opts.rateLimit) {
        await limit(opts.rateLimit.policy, opts.rateLimit.key(ctx));
      } else if (actor) {
        await limit("api:default", actor.userId);
      }

      const out = await opts.handler(ctx);

      if (out instanceof Response) {
        out.headers.set("x-request-id", requestId);
        return done(out);
      }

      return done(
        NextResponse.json({ data: out }, { headers: { "x-request-id": requestId } })
      );
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError(500, "internal_error", "Something went wrong");

      if (!(e instanceof ApiError)) {
        log.error({ requestId, path, err: errInfo(e) }, "unhandled error");
        captureServerError(e, { requestId, userId, route: path });
      }

      const headers: Record<string, string> = { "x-request-id": requestId };
      if (
        err.status === 429 &&
        err.details &&
        typeof err.details === "object" &&
        "retryAfter" in err.details &&
        typeof (err.details as { retryAfter?: unknown }).retryAfter === "number"
      ) {
        headers["Retry-After"] = String(
          (err.details as { retryAfter: number }).retryAfter
        );
      }

      const res = NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
            requestId,
          },
        },
        { status: err.status, headers }
      );

      if (err.status === 401) {
        clearResponseAuthCookies(res);
      }

      return done(res);
    }
  };
}
