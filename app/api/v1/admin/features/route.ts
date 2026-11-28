import { route } from "@/server/http/route";
import { listFeatureFlags } from "@/server/flags";

/** Step 10.6 (admins only): every feature switch, its state and where the state comes from. */
export const GET = route({
  disableCookieCache: true,
  handler: ({ actor }) => listFeatureFlags(actor),
});
