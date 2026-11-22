import { route } from "@/server/http/route";
import { usagePeriodQuerySchema } from "@/lib/schemas/usage";
import { getUsageByMember } from "@/server/services/usage";

/**
 * Step 9.3: who spent the credits billed to my account (me and the
 * collaborators in my workspaces), with Asks apart from main prompts.
 * Always the caller's own account: there is no way to ask for another's.
 */
export const GET = route({
  query: usagePeriodQuerySchema,
  handler: async ({ actor, query }) => ({ members: await getUsageByMember(actor.userId, query.period) }),
});
