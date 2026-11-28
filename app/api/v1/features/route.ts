import { route } from "@/server/http/route";
import { getFeatureStates } from "@/server/flags";

/** Step 10.6: which features are on right now (booleans only, no reasons). Signed-in people only. */
export const GET = route({
  handler: () => getFeatureStates(),
});
