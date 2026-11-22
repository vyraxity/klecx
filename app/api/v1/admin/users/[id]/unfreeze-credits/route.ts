import { route } from "@/server/http/route";
import { unfreezeCredits } from "@/server/services/account-moderation";

/** Step 8.6 (admins only): unfreeze an account's credits. */
export const POST = route({
  disableCookieCache: true,
  handler: ({ actor, params }) => unfreezeCredits(actor, params.id as string),
});
