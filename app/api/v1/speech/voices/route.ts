import { route } from "@/server/http/route";
import { getVoiceOverview } from "@/server/services/speech";

/** Step 9.4: the voices the person can use, their choice, and today's natural-voice seconds. */
export const GET = route({
  handler: async ({ actor }) => getVoiceOverview(actor.userId),
});
