import { route } from "@/server/http/route";
import { changePlanSchema } from "@/lib/schemas/billing";
import { changePlan } from "@/server/services/billing";

/** Step 8.5: upgrade the caller's subscription to `{ plan, interval }`. The client never sends a product id or price. */
export const POST = route({
  disableCookieCache: true,
  body: changePlanSchema,
  rateLimit: { policy: "billing:action", key: (c) => c.actor.userId },
  handler: ({ actor, body, requestId }) => changePlan(actor.userId, body, requestId),
});
