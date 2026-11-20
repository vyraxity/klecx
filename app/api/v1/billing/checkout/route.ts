import { route } from "@/server/http/route";
import { checkoutSchema } from "@/lib/schemas/billing";
import { startCheckout } from "@/server/services/billing";

/** Step 8.2: a hosted checkout for `{ plan, interval }`. The client never sends a product id or price. */
export const POST = route({
  disableCookieCache: true,
  body: checkoutSchema,
  rateLimit: { policy: "billing:action", key: (c) => c.actor.userId },
  handler: ({ actor, body, requestId }) => startCheckout(actor.userId, body, requestId),
});
