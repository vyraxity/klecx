import * as Sentry from "@sentry/nextjs";
import { SENTRY_TUNNEL_ROUTE, sharedSentryOptions } from "@/lib/monitoring/sentry-options";

// Step 10.2: browser errors, sent through our own origin (see app/sentry-tunnel).
Sentry.init({ ...sharedSentryOptions(), tunnel: SENTRY_TUNNEL_ROUTE });

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
