import * as Sentry from "@sentry/nextjs";
import { sharedSentryOptions } from "@/lib/monitoring/sentry-options";

// Step 10.2: errors in the edge runtime (none today; kept so nothing is missed).
Sentry.init({ ...sharedSentryOptions() });
