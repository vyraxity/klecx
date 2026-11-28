import { route } from "@/server/http/route";
import { Errors } from "@/server/http/errors";
import { setFeatureFlagSchema } from "@/lib/schemas/admin";
import { isFeatureKey } from "@/lib/features/flags";
import { setFeatureFlag } from "@/server/flags";

/**
 * Step 10.6 (admins only): pause (`{ enabled: false, reason }`) or resume
 * (`{ enabled: true }`) a feature without a redeploy. `ai` is the kill switch.
 */
export const PUT = route({
  disableCookieCache: true,
  body: setFeatureFlagSchema,
  handler: ({ actor, body, params }) => {
    if (actor.role !== "ADMIN") throw Errors.forbidden("Admin role required");
    const key = params.key as string;
    if (!isFeatureKey(key)) throw Errors.notFound("Feature");
    return setFeatureFlag(actor, key, body);
  },
});
