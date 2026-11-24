import { POST as forwardToSentry } from "@sentry/nextjs/tunnel";
import { sentryDsn } from "@/lib/monitoring/sentry-options";

/**
 * Step 10.2: browser → Sentry relay on our own origin. Forwards only the event
 * envelope (never cookies or headers) and only for our project's DSN. While
 * Sentry isn't configured, it quietly accepts and drops (the browser SDK is
 * off then anyway).
 */
export async function POST(request: Request): Promise<Response> {
  if (!sentryDsn()) return new Response(null, { status: 204 });
  return forwardToSentry(request);
}
