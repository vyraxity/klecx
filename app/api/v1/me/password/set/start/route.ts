import { route } from "@/server/http/route";
import { startPasswordSet } from "@/server/services/account-security";

/** Pre-10.6 fix: email a 6-digit code to add a password (accounts without one). */
export const POST = route({
  handler: async ({ actor }) => startPasswordSet(actor),
});
