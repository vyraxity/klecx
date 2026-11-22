import { route } from "@/server/http/route";
import { changeEmailSchema } from "@/lib/schemas/account-security";
import { requestEmailChange } from "@/server/services/account-security";

/**
 * Step 9.1: start an email change. The current address approves it, then the
 * new address verifies it; nothing changes until both links are clicked.
 */
export const POST = route({
  disableCookieCache: true,
  body: changeEmailSchema,
  handler: async ({ actor, body, req }) => requestEmailChange(actor, body.newEmail, req.headers),
});
