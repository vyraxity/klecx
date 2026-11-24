import { route } from "@/server/http/route";
import { requireAdmin } from "@/server/services/metrics";
import { runAlertChecks } from "@/server/monitoring/alerts";

/**
 * Step 10.2 (admins only): run the alert checks now (a drill, or after a fix).
 * The hourly run comes with the Step 10.3 job runner.
 */
export const POST = route({
  handler: ({ actor }) => {
    requireAdmin(actor);
    return runAlertChecks();
  },
});
