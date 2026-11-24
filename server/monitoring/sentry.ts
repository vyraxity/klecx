import "server-only";
import * as Sentry from "@sentry/nextjs";

/**
 * Step 10.2 — report a server error to Sentry with the request id and the
 * user's id (never the email). A no-op while Sentry isn't configured
 * (`SENTRY_DSN` unset): the SDK isn't initialised then.
 */
export function captureServerError(
  err: unknown,
  context: { requestId?: string; userId?: string; route?: string; tags?: Record<string, string> } = {}
): void {
  try {
    Sentry.withScope((scope) => {
      if (context.requestId) scope.setTag("request_id", context.requestId);
      if (context.route) scope.setTag("route", context.route);
      for (const [k, v] of Object.entries(context.tags ?? {})) scope.setTag(k, v);
      if (context.userId) scope.setUser({ id: context.userId });
      Sentry.captureException(err);
    });
  } catch {
    // Monitoring must never break the request.
  }
}
