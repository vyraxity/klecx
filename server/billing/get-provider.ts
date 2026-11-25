import "server-only";
import { env } from "@/server/env";
import { CREEM_TEST_API_BASE, createCreemProvider, type CreemProductIds } from "@/server/billing/creem";
import type { BillingProvider } from "@/server/billing/provider";
import { fakeCreemFetch } from "@/server/testing/e2e";

let testProvider: BillingProvider | null | undefined;

/** Tests only: replace the provider (`undefined` restores the real one). */
export function setBillingProviderForTests(provider: BillingProvider | null | undefined): void {
  testProvider = provider;
}

/** Creem product ids from env; null while any of the six is missing. */
export function creemProductsFromEnv(source: typeof env = env): CreemProductIds | null {
  const products = {
    LITE: { month: source.CREEM_PRODUCT_LITE_MONTH, year: source.CREEM_PRODUCT_LITE_YEAR },
    STANDARD: { month: source.CREEM_PRODUCT_STANDARD_MONTH, year: source.CREEM_PRODUCT_STANDARD_YEAR },
    PRO: { month: source.CREEM_PRODUCT_PRO_MONTH, year: source.CREEM_PRODUCT_PRO_YEAR },
  };
  const complete = Object.values(products).every((p) => p.month && p.year);
  return complete ? (products as CreemProductIds) : null;
}

/**
 * The configured billing provider, or null when billing isn't set up
 * (no `BILLING_PROVIDER`, no API key or a missing product id). Outside
 * production an unset `CREEM_API_BASE` means Creem's test API.
 */
export function getBillingProvider(): BillingProvider | null {
  if (testProvider !== undefined) return testProvider;
  if (env.BILLING_PROVIDER !== "creem" || !env.CREEM_API_KEY) return null;
  const products = creemProductsFromEnv();
  if (!products) return null;
  const apiBase = env.CREEM_API_BASE ?? (env.NODE_ENV === "production" ? undefined : CREEM_TEST_API_BASE);
  if (!apiBase) return null;
  return createCreemProvider(
    {
      apiKey: env.CREEM_API_KEY,
      apiBase,
      webhookSecret: env.CREEM_WEBHOOK_SECRET,
      products,
    },
    // Step 10.4: end-to-end test mode talks to a fake Creem (`server/testing/e2e.ts`).
    env.E2E_TEST_MODE ? fakeCreemFetch : fetch
  );
}
