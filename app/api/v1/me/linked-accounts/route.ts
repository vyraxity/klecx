import { route } from "@/server/http/route";
import { listLinkedAccounts } from "@/server/services/account-security";

/** Step 9.1: the signed-in person's sign-in methods (password, Google, GitHub). */
export const GET = route({
  disableCookieCache: true,
  handler: async ({ actor }) => listLinkedAccounts(actor.userId),
});
