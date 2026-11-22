import { route } from "@/server/http/route";
import { listMySupportTickets } from "@/server/services/support";

/** Step 9.1: the signed-in person's support requests (Settings → Support). */
export const GET = route({
  handler: async ({ actor }) => ({ tickets: await listMySupportTickets(actor.userId) }),
});
