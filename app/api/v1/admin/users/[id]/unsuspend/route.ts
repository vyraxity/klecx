import { route } from "@/server/http/route";
import { unsuspendUser } from "@/server/services/account-moderation";

/** Step 8.6 (admins only): lift a suspension. */
export const POST = route({
  disableCookieCache: true,
  handler: ({ actor, params }) => unsuspendUser(actor, params.id as string),
});
