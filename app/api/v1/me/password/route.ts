import { route } from "@/server/http/route";
import { changePasswordSchema } from "@/lib/schemas/account-security";
import { changePassword } from "@/server/services/account-security";

/** Step 9.1: change the password (current one required; other sessions are signed out). */
export const POST = route({
  disableCookieCache: true,
  body: changePasswordSchema,
  handler: async ({ actor, body }) => changePassword(actor, body),
});
