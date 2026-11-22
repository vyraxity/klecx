import { route } from "@/server/http/route";
import { freezeCreditsSchema } from "@/lib/schemas/admin";
import { freezeCredits } from "@/server/services/account-moderation";

/** Step 8.6 (admins only): freeze an account's credits (nothing may spend them). */
export const POST = route({
  disableCookieCache: true,
  body: freezeCreditsSchema,
  handler: ({ actor, body, params }) => freezeCredits(actor, params.id as string, body),
});
