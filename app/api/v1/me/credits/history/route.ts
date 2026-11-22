import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { createTranslator } from "use-intl/core";
import { messagesFor, resolveLocaleCode } from "@/i18n/messages";
import { LOCALE_COOKIE } from "@/i18n/config";
import { route } from "@/server/http/route";
import { creditHistoryQuerySchema } from "@/lib/schemas/usage";
import { HISTORY_CSV_MAX_ROWS, listCreditHistory } from "@/server/services/usage";
import { creditHistoryCsv } from "@/server/services/usage-csv";

/**
 * Step 9.3: the credit history (one line per finished AI call, plus grants,
 * expiries, refunds and adjustments), newest first. `format=csv` downloads up
 * to 5,000 lines in the page's language.
 */
export const GET = route({
  query: creditHistoryQuerySchema,
  handler: async ({ actor, query, req }) => {
    if (query.format === "csv") {
      const { entries } = await listCreditHistory(actor.userId, {
        type: query.type,
        limit: HISTORY_CSV_MAX_ROWS,
      });
      const t = await csvTranslator(req.cookies.get(LOCALE_COOKIE)?.value);
      const csv = creditHistoryCsv(entries, t);
      return new NextResponse(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="klecx-credit-history-${new Date().toISOString().slice(0, 10)}.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    return listCreditHistory(actor.userId, { cursor: query.cursor, type: query.type });
  },
});

type T = (key: string, values?: Record<string, unknown>) => string;

/** The request's language; outside a Next request (tests, jobs) the cookie's, else English. */
async function csvTranslator(cookieLocale: string | undefined): Promise<T> {
  try {
    return (await getTranslations()) as unknown as T;
  } catch {
    const locale = resolveLocaleCode(cookieLocale);
    return createTranslator({ locale, messages: messagesFor(locale) }) as unknown as T;
  }
}
