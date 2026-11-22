import type { LocaleCode } from "@/i18n/locales";

/**
 * Step 9.2: first-visit language suggestion. The app picks its language from
 * the browser (Accept-Language); when the visitor's country mostly speaks
 * another language Klecx offers, a dismissible banner suggests switching.
 * Only countries where that language is clearly the main one are listed
 * (multilingual countries such as Canada, Belgium or Switzerland are left
 * out on purpose).
 */
export const LOCALE_SUGGESTION_COOKIE = "klecx_locale_suggestion";
export const LOCALE_SUGGESTION_MAX_AGE = 60 * 60 * 24 * 365;

const SPANISH = ["ES", "MX", "AR", "CO", "CL", "PE", "VE", "EC", "GT", "CU", "BO", "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR", "GQ"];
const FRENCH = ["FR", "MC", "SN", "CI", "ML", "BF", "NE", "GN", "BJ", "TG", "CD", "CG", "GA", "MG", "HT", "DJ", "TD", "CF", "BI", "KM"];

export const COUNTRY_LOCALE: Readonly<Record<string, LocaleCode>> = Object.freeze({
  ...Object.fromEntries(SPANISH.map((c) => [c, "es" as const])),
  ...Object.fromEntries(FRENCH.map((c) => [c, "fr" as const])),
});

export interface LocaleSuggestionInput {
  /** The language the page is rendered in. */
  currentLocale: string;
  /** Two-letter country from the host's geo header (Vercel), if any. */
  country: string | null;
  /** The person already chose a language (cookie or account): never suggest. */
  hasChosenLocale: boolean;
  /** The banner was dismissed or answered on this device. */
  dismissed: boolean;
}

/** The language to suggest, or null. */
export function suggestLocale(input: LocaleSuggestionInput): LocaleCode | null {
  if (input.hasChosenLocale || input.dismissed || !input.country) return null;
  const suggested = COUNTRY_LOCALE[input.country.toUpperCase()];
  return suggested && suggested !== input.currentLocale ? suggested : null;
}

/** What the banner shows (built on the server by getLocaleSuggestion()). */
export interface LocaleSuggestion {
  locale: string;
  /** Shown in the suggested language, so the visitor can read it. */
  strings: { message: string; switchLabel: string; dismissLabel: string; regionLabel: string };
}
