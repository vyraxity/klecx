import { route } from "@/server/http/route";
import { adminResetTwoFactor } from "@/server/services/two-factor";

/**
 * Admins only: remove two-factor from an account whose owner lost their
 * authenticator app and backup codes, once support has verified who they are.
 */
export const POST = route({
  disableCookieCache: true,
  handler: ({ actor, params }) => adminResetTwoFactor(actor, params.id as string),
});
