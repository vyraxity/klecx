import { z } from "zod";
import { route } from "@/server/http/route";
import { getBusinessMetrics } from "@/server/services/metrics";

const isoDate = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date");

/**
 * Step 10.2 (admins only): business metrics for the admin console —
 * generations, failures, latency, provider cost vs revenue per plan, credits,
 * searches, voice, reviews, Asks, notes, refunds, disputes, webhooks, funnel
 * and plan-limit hits. `from`/`to` are dates or ISO timestamps (UTC, `to`
 * excluded); default: the last 7 full days plus today.
 */
export const GET = route({
  query: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  handler: ({ actor, query }) => {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - 7));
    return getBusinessMetrics(actor, { from, to });
  },
});
