import { route } from "@/server/http/route";
import { usagePeriodQuerySchema } from "@/lib/schemas/usage";
import { getUsageSummary } from "@/server/services/usage";

/** Step 9.3: the signed-in person's credit period (allowance, spending, breakdowns, daily cap). */
export const GET = route({
  query: usagePeriodQuerySchema,
  handler: async ({ actor, query }) => getUsageSummary(actor.userId, query.period),
});
