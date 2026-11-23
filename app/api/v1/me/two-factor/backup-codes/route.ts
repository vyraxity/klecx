import { route } from "@/server/http/route";
import { twoFactorPasswordSchema } from "@/lib/schemas/account-security";
import { regenerateBackupCodes } from "@/server/services/two-factor";

/** New backup codes (the old ones stop working). Needs the password. */
export const POST = route({
  disableCookieCache: true,
  body: twoFactorPasswordSchema,
  handler: ({ actor, body, req }) => regenerateBackupCodes(actor, body.password, req.headers),
});
