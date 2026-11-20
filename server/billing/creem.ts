import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BillingProviderError,
  WebhookSignatureError,
  type BillingInterval,
  type BillingProvider,
  type NormalizedEvent,
  type PaidPlanKey,
} from "@/server/billing/provider";

/**
 * Creem adapter (Step 8.2), plain `fetch` with the `x-api-key` header.
 * Paths and fields checked against docs.creem.io on 2026-11-19:
 * - `POST /v1/checkouts` { product_id, request_id, success_url, customer: { id | email }, metadata } → { id, checkout_url }
 * - `POST /v1/customers/billing` { customer_id } → { customer_portal_link }
 * - `POST /v1/subscriptions/{id}/cancel` { mode: "scheduled" | "immediate", onExecute: "cancel" }
 * - webhooks: `creem-signature` = hex HMAC-SHA256 of the raw body with the webhook secret;
 *   payload { id: "evt_…", eventType, created_at (ms), object }.
 * Errors come back as { trace_id, status, error, message[] }.
 */

export const CREEM_TEST_API_BASE = "https://test-api.creem.io";
export const CREEM_LIVE_API_BASE = "https://api.creem.io";

/** No retries: checkouts and cancellations are not idempotent. */
export const CREEM_TIMEOUT_MS = 10_000;

export type CreemProductIds = Record<PaidPlanKey, Record<BillingInterval, string>>;

export type CreemConfig = {
  apiKey: string;
  apiBase: string;
  webhookSecret?: string;
  products: CreemProductIds;
};

/** plan + interval → Creem product id. Only the server knows product ids; the client sends `{ plan, interval }`. */
export function creemProductId(
  products: CreemProductIds,
  plan: PaidPlanKey,
  interval: BillingInterval
): string {
  const id = products[plan]?.[interval];
  if (!id) {
    throw new BillingProviderError("checkout", `No Creem product for ${plan}/${interval}`);
  }
  return id;
}

type FetchLike = typeof fetch;

export function createCreemProvider(config: CreemConfig, fetchImpl: FetchLike = fetch): BillingProvider {
  const base = config.apiBase.replace(/\/+$/, "");

  async function call<T>(operation: string, path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CREEM_TIMEOUT_MS),
      });
    } catch (e) {
      const cause = e instanceof Error ? e.name : "unknown";
      throw new BillingProviderError(operation, "Creem request failed", { cause });
    }

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const traceId = typeof json?.trace_id === "string" ? json.trace_id : undefined;
      throw new BillingProviderError(operation, `Creem answered ${res.status}`, {
        status: res.status,
        traceId,
      });
    }
    if (!json) {
      throw new BillingProviderError(operation, "Creem sent an unreadable response", { status: res.status });
    }
    return json as T;
  }

  return {
    name: "creem",

    async createCheckout(input) {
      const productId = creemProductId(config.products, input.plan, input.interval);
      const out = await call<{ id?: unknown; checkout_url?: unknown }>("checkout", "/v1/checkouts", {
        product_id: productId,
        request_id: input.requestId,
        success_url: input.successUrl,
        // Creem takes one of `id` or `email`.
        customer: input.customerId ? { id: input.customerId } : { email: input.email },
        metadata: { userId: input.userId, plan: input.plan, interval: input.interval },
      });
      if (typeof out.checkout_url !== "string" || typeof out.id !== "string") {
        throw new BillingProviderError("checkout", "Creem checkout response has no checkout_url");
      }
      return { url: out.checkout_url, checkoutId: out.id };
    },

    async createPortalLink(customerId) {
      const out = await call<{ customer_portal_link?: unknown }>("portal", "/v1/customers/billing", {
        customer_id: customerId,
      });
      if (typeof out.customer_portal_link !== "string") {
        throw new BillingProviderError("portal", "Creem portal response has no customer_portal_link");
      }
      return { url: out.customer_portal_link };
    },

    async cancelSubscription(subscriptionId, { atPeriodEnd }) {
      await call(
        "cancel",
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
        atPeriodEnd ? { mode: "scheduled", onExecute: "cancel" } : { mode: "immediate" }
      );
    },

    verifyWebhook(rawBody, signature) {
      if (!config.webhookSecret) {
        throw new BillingProviderError("webhook", "CREEM_WEBHOOK_SECRET is not set");
      }
      if (!signature) throw new WebhookSignatureError("Missing creem-signature header");
      const expected = createHmac("sha256", config.webhookSecret).update(rawBody, "utf8").digest();
      const given = /^[0-9a-f]+$/i.test(signature.trim()) ? Buffer.from(signature.trim(), "hex") : Buffer.alloc(0);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new WebhookSignatureError();
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw new WebhookSignatureError("Webhook body is not JSON");
      }
      const p = payload as { id?: unknown; eventType?: unknown; created_at?: unknown; object?: unknown };
      if (typeof p.id !== "string" || typeof p.eventType !== "string") {
        throw new WebhookSignatureError("Webhook body has no id or eventType");
      }
      const createdAt =
        typeof p.created_at === "number" ? new Date(p.created_at) : new Date(String(p.created_at ?? ""));
      const event: NormalizedEvent = {
        provider: "creem",
        id: p.id,
        type: p.eventType,
        createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
        object: p.object ?? null,
        payload,
      };
      return event;
    },
  };
}
