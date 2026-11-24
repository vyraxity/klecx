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
 * Provider price of one executed web search (grounding), USD. The provider
 * bills searches separately from tokens; check its pricing page when prices
 * change (the surcharge we charge is GROUNDING_SURCHARGE_CREDITS × CREDIT_USD).
 */
export const PROVIDER_SEARCH_USD = 0.014;

/** What we charge for one search, USD (the credit surcharge). */
export const SEARCH_SURCHARGE_USD = GROUNDING_SURCHARGE_CREDITS * CREDIT_USD;

type Usage = {
  inputTokens?: unknown;
  outputTokens?: unknown;
  thoughtTokens?: unknown;
  searches?: unknown;
  seconds?: unknown;
  chars?: unknown;
  images?: unknown;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function readUsage(raw: unknown): Usage {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Usage) : {};
}

export function searchesOf(raw: unknown): number {
  return num(readUsage(raw).searches);
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
  const tokens =
    (num(u.inputTokens) * price.in + (num(u.outputTokens) + num(u.thoughtTokens)) * price.out) / 1_000_000;
  return tokens + num(u.searches) * PROVIDER_SEARCH_USD;
}
