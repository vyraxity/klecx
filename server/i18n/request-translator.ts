import "server-only";
import { getTranslations } from "next-intl/server";
import { createTranslator } from "use-intl/core";
import { messagesFor, resolveLocaleCode } from "@/i18n/messages";
import { LOCALE_COOKIE } from "@/i18n/config";

export type ServerT = (key: string, values?: Record<string, unknown>) => string;

/**
 * The request's translator for text an API route produces (CSV headers,
 * spoken placeholders). Outside a Next request (tests, jobs) it uses the
 * locale cookie, else English.
 */
export async function requestTranslator(req: { cookies: { get(name: string): { value: string } | undefined } }): Promise<ServerT> {
  try {
    return (await getTranslations()) as unknown as ServerT;
  } catch {
    const locale = resolveLocaleCode(req.cookies.get(LOCALE_COOKIE)?.value);
    return createTranslator({ locale, messages: messagesFor(locale) }) as unknown as ServerT;
  }
}
