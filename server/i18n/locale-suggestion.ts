import "server-only";
import { cookies, headers } from "next/headers";
import { createTranslator } from "use-intl/core";
import { messagesFor } from "@/i18n/messages";
import { db } from "@/server/db/client";
import { LOCALE_COOKIE } from "@/i18n/config";
import {
  LOCALE_SUGGESTION_COOKIE,
  suggestLocale,
  type LocaleSuggestion,
} from "@/lib/i18n/locale-suggestion";

/**
 * Step 9.2: the banner's content for this request, or null. Reads the geo
 * header Vercel sets (`x-vercel-ip-country`; `cf-ipcountry` elsewhere).
 */
export async function getLocaleSuggestion(
  currentLocale: string,
  userId: string | null
): Promise<LocaleSuggestion | null> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const savedLocale = userId
    ? await db.userPreference
        .findUnique({ where: { userId }, select: { uiLocale: true } })
        .then((p) => p?.uiLocale ?? null)
        .catch(() => null)
    : null;

  const locale = suggestLocale({
    currentLocale,
    country: headerStore.get("x-vercel-ip-country") || headerStore.get("cf-ipcountry"),
    hasChosenLocale: Boolean(cookieStore.get(LOCALE_COOKIE)?.value || savedLocale),
    dismissed: Boolean(cookieStore.get(LOCALE_SUGGESTION_COOKIE)?.value),
  });
  if (!locale) return null;

  // In the suggested language (each message names its own language,
  // "…disponible en français"). Not getTranslations(): the request config
  // always answers with the page's own language.
  const t = createTranslator({
    locale,
    messages: messagesFor(locale),
    namespace: "LocaleSuggestion",
  }) as unknown as (key: string) => string;
  return {
    locale,
    strings: {
      message: t("message"),
      switchLabel: t("switch"),
      dismissLabel: t("dismiss"),
      regionLabel: t("label"),
    },
  };
}
