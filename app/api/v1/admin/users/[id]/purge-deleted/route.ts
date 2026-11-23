import { route } from "@/server/http/route";
import { adminPurgeSchema } from "@/lib/schemas/account-data";
import { adminPurgeDeletedAccount } from "@/server/services/account-deletion";

/**
 * Step 9.5 (admins only): erase a deleted account now. Only after its grace
 * period unless `force` (a verified erasure request); never an account that
 * isn't deleted (404).
 */
export const POST = route({
  disableCookieCache: true,
  body: adminPurgeSchema,
  handler: ({ actor, body, params }) => adminPurgeDeletedAccount(actor, params.id as string, Boolean(body.force)),
});
