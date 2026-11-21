import { route } from "@/server/http/route";
import { resumeSubscription } from "@/server/services/billing";

/** Step 8.5: undo the caller's scheduled cancellation. */
export const POST = route({
  disableCookieCache: true,
  rateLimit: { policy: "billing:action", key: (c) => c.actor.userId },
  handler: ({ actor, requestId }) => resumeSubscription(actor.userId, requestId),
});
