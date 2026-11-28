import { route } from "@/server/http/route";
import { setPasswordConfirmSchema } from "@/lib/schemas/account-security";
import { confirmPasswordSet } from "@/server/services/account-security";

/** Pre-10.6 fix: the emailed code + the new password add a password to the account. */
export const POST = route({
  disableCookieCache: true,
  body: setPasswordConfirmSchema,
  rateLimit: { policy: "auth:reauth", key: (c) => c.actor.userId },
  handler: async ({ actor, body }) => confirmPasswordSet(actor, body),
});
