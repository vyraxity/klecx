import { NextResponse } from "next/server";
import { route } from "@/server/http/route";
import { updatePreferencesSchema } from "@/lib/schemas/user-preferences";
import {
  getUserPreferences,
  updateUserPreferences,
} from "@/server/services/user-preferences";
import { LOCALE_COOKIE } from "@/lib/locale";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE } from "@/lib/theme";

export const GET = route({
  handler: async ({ actor }) => {
    return getUserPreferences(actor.userId);
  },
});

export const PATCH = route({
  body: updatePreferencesSchema,
  handler: async ({ actor, body }) => {
    const result = await updateUserPreferences(actor.userId, body);

    const res = NextResponse.json({ data: result });

    if (body.uiLocale) {
      res.cookies.set(LOCALE_COOKIE, body.uiLocale, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365, // 1 year
        sameSite: "lax",
      });
    } else if (body.uiLocale === null) {
      // Step 9.1: "Automatic" — the browser's language decides again (Accept-Language).
      res.cookies.delete(LOCALE_COOKIE);
    }

    if (body.theme) {
      // Step 9.2: this device follows at once; others read the account on their next load.
      res.cookies.set(THEME_COOKIE, body.theme, {
        path: "/",
        maxAge: THEME_COOKIE_MAX_AGE,
        sameSite: "lax",
      });
    }

    return res;
  },
});
