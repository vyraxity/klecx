import { route } from "@/server/http/route";
import { usageTimeseriesQuerySchema } from "@/lib/schemas/usage";
import { getUsageTimeseries } from "@/server/services/usage";

const DAY_MS = 86_400_000;

/** Step 9.3: credits and AI calls per UTC day (default: the last 30 days; at most 366). */
export const GET = route({
  query: usageTimeseriesQuerySchema,
  handler: async ({ actor, query }) => {
    const to = query.to ? new Date(`${query.to}T00:00:00Z`) : new Date();
    const from = query.from ? new Date(`${query.from}T00:00:00Z`) : new Date(to.getTime() - 29 * DAY_MS);
    return { points: await getUsageTimeseries(actor.userId, from, to) };
  },
});
