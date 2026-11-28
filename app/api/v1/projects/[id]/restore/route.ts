import { route } from "@/server/http/route";
import { restoreDeletedProject } from "@/server/services/recently-deleted";

/** Pre-10.6 fix: restore a deleted project within 30 days (owner only). */
export const POST = route({
  handler: async ({ actor, params }) => restoreDeletedProject(actor, params.id as string),
});
