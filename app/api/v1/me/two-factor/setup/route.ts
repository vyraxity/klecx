import { route } from "@/server/http/route";
import { twoFactorPasswordSchema } from "@/lib/schemas/account-security";
import { startTwoFactorSetup } from "@/server/services/two-factor";

/** Step 1 of turning two-factor on: password → QR code, key and backup codes. */
export const POST = route({
  disableCookieCache: true,
  body: twoFactorPasswordSchema,
  handler: ({ actor, body, req }) => startTwoFactorSetup(actor, body.password, req.headers),
});
