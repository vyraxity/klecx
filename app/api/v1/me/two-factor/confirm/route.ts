import { route } from "@/server/http/route";
import { twoFactorCodeSchema } from "@/lib/schemas/account-security";
import { confirmTwoFactorSetup } from "@/server/services/two-factor";

/** Step 2: the first code from the authenticator app turns two-factor on. */
export const POST = route({
  disableCookieCache: true,
  body: twoFactorCodeSchema,
  handler: ({ actor, body, req }) => confirmTwoFactorSetup(actor, body.code, req.headers),
});
