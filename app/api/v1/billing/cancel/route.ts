import { route } from "@/server/http/route";
import { cancelSubscriptionSchema } from "@/lib/schemas/billing";
import { cancelSubscription } from "@/server/services/billing";

/** Step 8.2: cancel the caller's subscription at the end of the paid period. */
export const POST = route({
  disableCookieCache: true,
  body: cancelSubscriptionSchema,
  rateLimit: { policy: "billing:action", key: (c) => c.actor.userId },
  handler: ({ actor, requestId }) => cancelSubscription(actor.userId, requestId),
});
