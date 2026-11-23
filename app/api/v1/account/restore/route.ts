import { route } from "@/server/http/route";
import { getClientIp } from "@/server/http/rate-limit";
import { restoreAccountSchema } from "@/lib/schemas/account-data";
import { restoreAccount } from "@/server/services/account-deletion";

/** Step 9.5: the link in the deletion email restores the account (no sign-in needed). */
export const POST = route({
  auth: "optional",
  body: restoreAccountSchema,
  rateLimit: { policy: "account:restore", key: (c) => getClientIp(c.req) ?? "anonymous" },
  handler: ({ body }) => restoreAccount(body.token),
});
