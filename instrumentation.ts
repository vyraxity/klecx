import * as Sentry from "@sentry/nextjs";

/** Step 10.2: load Sentry for the runtime that starts (off until NEXT_PUBLIC_SENTRY_DSN is set). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

/** Errors thrown while rendering or in route handlers, with the route and request context. */
export const onRequestError = Sentry.captureRequestError;
