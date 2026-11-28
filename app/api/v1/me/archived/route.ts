import { route } from "@/server/http/route";
import { listArchived } from "@/server/services/archived";

/**
 * Pre-10.6 fix PR 8: the archived workspaces and projects the caller can open,
 * for the Archived tab of Settings → Deleted & archived.
 */
export const GET = route({
  handler: async ({ actor }) => listArchived(actor),
});
