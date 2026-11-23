import { route } from "@/server/http/route";
import { getTwoFactorStatus } from "@/server/services/two-factor";

/** Two-factor sign-in status for Settings → Security. */
export const GET = route({
  disableCookieCache: true,
  handler: ({ actor }) => getTwoFactorStatus(actor.userId),
});
