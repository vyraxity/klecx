import "server-only";
import { MODEL_CATALOG, isModelKey, CREDIT_USD, GROUNDING_SURCHARGE_CREDITS } from "@/lib/ai/model-catalog";
import { speechPrices } from "@/lib/speech/pricing";

/**
 * Step 10.2 — what an AI call cost us at the provider, in USD, from the usage
 * recorded on its `Generation` and the prices in `lib/ai/model-catalog.ts`
 * (the same prices credits are computed from). Used by the metrics and the
 * cost alerts. A call with no usage recorded costs 0 here.
 */

/**
 * Provider price of one search query (Grounding with Google Search), USD:
 * $14 per 1,000 **queries**, after 5,000 free search requests a month shared
 * by every Gemini 3+ model on the account (confirmed by the owner from the
 * pricing page, Standard tab, 2026-11-24). One grounded request can run
 * several queries. Costs here ignore the free allowance (it's per account and
 * month); the metrics show the month's count against it.
 */
export const PROVIDER_SEARCH_USD = 0.014;

/** Grounded requests free per month (account-wide, all Gemini 3+ models). */
export const FREE_SEARCH_REQUESTS_PER_MONTH = 5000;

/** The provider's daily cap on grounded requests (account-wide). */
export const DAILY_SEARCH_REQUEST_CAP = 1500;

/** What we charge for one search, USD (the credit surcharge). */
export const SEARCH_SURCHARGE_USD = GROUNDING_SURCHARGE_CREDITS * CREDIT_USD;

type Usage = {
  inputTokens?: unknown;
  outputTokens?: unknown;
  thoughtTokens?: unknown;
  searches?: unknown;
  searchQueries?: unknown;
  searchInputTokens?: unknown;
  searchOutputTokens?: unknown;
  audioInputTokens?: unknown;
  seconds?: unknown;
  chars?: unknown;
  images?: unknown;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function readUsage(raw: unknown): Usage {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Usage) : {};
}

/** Web searches (grounded requests) behind one call. */
export function searchesOf(raw: unknown): number {
  return num(readUsage(raw).searches);
}

/** Search queries the provider ran (older rows recorded only `searches`: one each). */
export function searchQueriesOf(raw: unknown): number {
  const u = readUsage(raw);
  return num(u.searchQueries) || num(u.searches);
}

/** The search requests' own cost: queries + their tokens on the economy model. */
export function searchCostUsd(raw: unknown): number {
  const u = readUsage(raw);
  const economy = MODEL_CATALOG["text-economy"].priceUsdPerM ?? { in: 0, out: 0 };
  return (
    searchQueriesOf(raw) * PROVIDER_SEARCH_USD +
    (num(u.searchInputTokens) * economy.in + num(u.searchOutputTokens) * economy.out) / 1_000_000
  );
}

export interface CostInput {
  kind: string;
  modelKey: string;
  status: string;
  usage: unknown;
  createdAt: Date;
}

/** Provider cost of one call, USD: tokens (or images, or audio seconds) plus executed searches. */
export function generationCostUsd(g: CostInput): number {
  const u = readUsage(g.usage);
  if (g.kind === "SPEECH") {
    const p = speechPrices(g.createdAt);
    return num(u.seconds) * p.usdPerAudioSecond + (Math.ceil(num(u.chars) / 4) * p.usdPerMillionInputTokens) / 1_000_000;
  }
  if (!isModelKey(g.modelKey)) return 0;
  const model = MODEL_CATALOG[g.modelKey];
  if (model.kind === "IMAGE") {
    // An image is billed by the provider only when one was produced.
    return g.status === "COMPLETED" ? (num(u.images) || 1) * (model.priceUsdPerImage ?? 0) : 0;
  }
  const price = model.priceUsdPerM ?? { in: 0, out: 0 };
  // Audio input (voice) has its own price; the rest of the input is text.
  const audio = Math.min(num(u.audioInputTokens), num(u.inputTokens));
  const audioPrice = model.priceUsdPerMAudioIn ?? price.in;
  const tokens =
    ((num(u.inputTokens) - audio) * price.in + audio * audioPrice + (num(u.outputTokens) + num(u.thoughtTokens)) * price.out) /
    1_000_000;
  return tokens + searchCostUsd(g.usage);
}
