import { z } from "zod";
import { route } from "@/server/http/route";
import { requireAdmin } from "@/server/services/metrics";
import { listAlerts } from "@/server/monitoring/alerts";

/** Step 10.2 (admins only): recent monitoring alerts, last seen first. */
export const GET = route({
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
  handler: ({ actor, query }) => {
    requireAdmin(actor);
    return listAlerts(query.limit ?? 50);
  },
});
