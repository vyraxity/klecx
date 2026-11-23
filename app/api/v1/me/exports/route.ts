import { after } from "next/server";
import { route } from "@/server/http/route";
import { LOCALE_COOKIE } from "@/i18n/config";
import { buildDataExport, getDataExports, requestDataExport, savedUiLocale } from "@/server/services/data-export";

/** Step 9.5: the person's recent data exports and when the next one can be requested. */
export const GET = route({
  handler: ({ actor }) => getDataExports(actor.userId),
});

/**
 * Step 9.5: request a copy of your data (one per day). Answers at once; the
 * ZIP is built after the response and an email says when it's ready.
 */
export const POST = route({
  rateLimit: { policy: "data:export", key: (c) => c.actor.userId },
  handler: async ({ actor, req }) => {
    const created = await requestDataExport(actor);
    const locale = (await savedUiLocale(actor.userId)) ?? req.cookies.get(LOCALE_COOKIE)?.value;
    const build = () => buildDataExport(created.id, { locale });
    try {
      after(build);
    } catch {
      // Outside a Next request (tests, scripts): start it now.
      void build();
    }
    return created;
  },
});
