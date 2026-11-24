import { route } from "@/server/http/route";
import { requireAdmin } from "@/server/services/metrics";

/**
 * Step 10.2 (admins only): throws on purpose, to check that an unexpected
 * error reaches Sentry and the logs with the same request id (the 500
 * response shows it). Changes nothing.
 */
export const POST = route({
  handler: ({ actor }) => {
    requireAdmin(actor);
    throw new Error("Monitoring test error (admin drill)");
  },
});
