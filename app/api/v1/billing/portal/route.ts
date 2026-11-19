import { route } from "@/server/http/route";
import { createPortalLink } from "@/server/services/billing";

/** Step 8.2: a link to the billing provider's customer portal for the caller's subscription. */
export const POST = route({
  disableCookieCache: true,
  rateLimit: { policy: "billing:action", key: (c) => c.actor.userId },
  handler: ({ actor, requestId }) => createPortalLink(actor.userId, requestId),
});
