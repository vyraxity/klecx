import { route } from "@/server/http/route";
import { listRecentlyDeleted } from "@/server/services/recently-deleted";

/** Pre-10.6 fix: the caller's own workspaces and projects deleted in the last 30 days. */
export const GET = route({
  handler: async ({ actor }) => listRecentlyDeleted(actor),
});
