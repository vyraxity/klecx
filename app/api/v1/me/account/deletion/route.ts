import { NextResponse } from "next/server";
import { clearResponseAuthCookies, route } from "@/server/http/route";
import { deleteAccountSchema } from "@/lib/schemas/account-data";
import { getDeletionOverview, requestAccountDeletion } from "@/server/services/account-deletion";

/** Step 9.5: what deleting the account involves (workspaces to transfer first, subscription). */
export const GET = route({
  handler: ({ actor }) => getDeletionOverview(actor.userId),
});

/**
 * Step 9.5: delete the account. Fresh sign-in (or password) and the email typed
 * as confirmation; 409 `deletion_blocked` while shared workspaces/projects remain.
 * Signs the person out everywhere.
 */
export const POST = route({
  disableCookieCache: true,
  body: deleteAccountSchema,
  rateLimit: { policy: "account:delete", key: (c) => c.actor.userId },
  handler: async ({ actor, body, requestId }) => {
    const result = await requestAccountDeletion(actor, body, requestId);
    const res = NextResponse.json({ data: result });
    clearResponseAuthCookies(res);
    return res;
  },
});
