import { z } from "zod";
import { route } from "@/server/http/route";
import {
  countWorkspaceAnnotations,
  listWorkspaceAnnotations,
} from "@/server/services/annotation";

export const GET = route({
  // `?summary=1`: only the counts (the top bar's "Comments & Asks" badge).
  query: z.object({ summary: z.enum(["1"]).optional() }),
  handler: async ({ actor, params, query }) => {
    if (query.summary === "1") {
      return countWorkspaceAnnotations(actor, params.id as string);
    }
    return listWorkspaceAnnotations(actor, params.id as string);
  },
});
