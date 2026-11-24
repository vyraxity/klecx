import * as Sentry from "@sentry/nextjs";
import { sharedSentryOptions } from "@/lib/monitoring/sentry-options";

// Step 10.2: server errors (route handlers, server components, server actions).
Sentry.init({ ...sharedSentryOptions() });
