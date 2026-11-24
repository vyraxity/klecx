import { route } from "@/server/http/route";
import { twoFactorPasswordSchema } from "@/lib/schemas/account-security";
import { disableTwoFactor } from "@/server/services/two-factor";

/** Turns two-factor off (secret, backup codes and trusted devices removed). Needs the password. */
export const POST = route({
  disableCookieCache: true,
  body: twoFactorPasswordSchema,
  handler: ({ actor, body }) => disableTwoFactor(actor, body.password),
});
