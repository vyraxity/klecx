import { route } from "@/server/http/route";
import { suspendUserSchema } from "@/lib/schemas/admin";
import { suspendUser } from "@/server/services/account-moderation";

/** Step 8.6 (admins only): suspend an account — sign-in refused, sessions revoked, optionally credits frozen. */
export const POST = route({
  disableCookieCache: true,
  body: suspendUserSchema,
  handler: ({ actor, body, params }) => suspendUser(actor, params.id as string, body),
});
