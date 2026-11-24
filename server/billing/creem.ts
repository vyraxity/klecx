import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BILLING_INTERVALS,
  BillingProviderError,
  PAID_PLANS,
  WebhookSignatureError,
  type BillingEventData,
  type BillingInterval,
  type BillingProvider,
  type NormalizedEvent,
  type PaidPlanKey,
  type ProviderSubscriptionStatus,
} from "@/server/billing/provider";

/**
 * Creem adapter (Step 8.2), plain `fetch` with the `x-api-key` header.
 * Paths and fields checked against docs.creem.io on 2026-11-19:
 * - `POST /v1/checkouts` { product_id, request_id, success_url, customer: { id | email }, metadata } → { id, checkout_url }
 * - `POST /v1/customers/billing` { customer_id } → { customer_portal_link }
 * - `POST /v1/subscriptions/{id}/cancel` { mode: "scheduled" | "immediate", onExecute: "cancel" }
 * - `POST /v1/subscriptions/{id}/resume` (no body; only `paused` / `scheduled_cancel` subscriptions) — 2026-11-21
 * - `POST /v1/subscriptions/{id}/upgrade` { product_id, update_behavior } — 2026-11-21; takes effect now,
 *   `proration-charge-immediately` charges the prorated difference at once
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

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Creem sends related objects either expanded (`{ id, … }`) or as a bare id. */
const idOf = (v: unknown): string | null => asString(v) ?? asString(asObject(v)?.id);
function asDate(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const CREEM_STATUSES: Record<string, ProviderSubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "unpaid",
  paused: "paused",
  scheduled_cancel: "scheduled_cancel",
  canceled: "canceled",
  cancelled: "canceled",
  expired: "expired",
};

function readSubscription(v: unknown): BillingEventData["subscription"] {
  const o = asObject(v);
  const id = idOf(v);
  if (!id) return null;
  return {
    id,
    status: CREEM_STATUSES[asString(o?.status) ?? ""] ?? "unknown",
    productId: idOf(o?.product),
    currentPeriodStart: asDate(o?.current_period_start_date),
    currentPeriodEnd: asDate(o?.current_period_end_date),
    canceledAt: asDate(o?.canceled_at),
  };
}

function readTransaction(v: unknown): BillingEventData["transaction"] {
  const o = asObject(v);
  const id = idOf(v);
  if (!id) return null;
  return {
    id,
    amountPaid: asNumber(o?.amount_paid) ?? asNumber(o?.amount),
    refundedAmount: asNumber(o?.refunded_amount),
  };
}

/**
 * Reads the fields the state machine needs out of a Creem event object
 * (docs.creem.io `code/webhooks`, read 2026-11-20). `checkout.completed` carries
 * a checkout (`request_id`, `metadata`, `customer`, `subscription`, `order`);
 * `subscription.*` a subscription (`last_transaction` on paid/canceled/expired);
 * `refund.created` a refund (`refund_amount`, `reason`, `transaction`,
 * `subscription`, `checkout`); `dispute.created` a dispute.
 */
export function readCreemEventData(type: string, object: unknown): BillingEventData {
  const o = asObject(object) ?? {};
  const isSubscription = type.startsWith("subscription.");
  const checkout = type === "checkout.completed" ? o : asObject(o.checkout);
  const metadata = asObject(o.metadata) ?? asObject(checkout?.metadata) ?? {};

  const subscription = isSubscription ? readSubscription(o) : readSubscription(o.subscription);
  const transaction = isSubscription
    ? readTransaction(o.last_transaction ?? o.last_transaction_id)
    : type === "checkout.completed"
      ? readTransaction(asObject(o.order)?.transaction)
      : readTransaction(o.transaction);

  return {
    requestId: asString(o.request_id) ?? asString(checkout?.request_id),
    metadataUserId: asString(metadata.userId),
    metadataPlan: asString(metadata.plan),
    metadataInterval: asString(metadata.interval),
    customerId: idOf(o.customer) ?? (isSubscription ? null : idOf(asObject(o.subscription)?.customer)),
    subscription,
    transaction,
    refund:
      type === "refund.created" && idOf(o)
        ? { id: idOf(o)!, amount: asNumber(o.refund_amount), reason: asString(o.reason) }
        : null,
    dispute: type === "dispute.created" && idOf(o) ? { id: idOf(o)! } : null,
  };
}

export function createCreemProvider(config: CreemConfig, fetchImpl: FetchLike = fetch): BillingProvider {
  const base = config.apiBase.replace(/\/+$/, "");

  async function call<T>(operation: string, path: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          "x-api-key": config.apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

    async resumeSubscription(subscriptionId) {
      await call("resume", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/resume`);
    },

    async changeSubscriptionPlan(subscriptionId, target) {
      await call("change_plan", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/upgrade`, {
        product_id: creemProductId(config.products, target.plan, target.interval),
        update_behavior: "proration-charge-immediately",
      });
    },

    async getSubscription(subscriptionId) {
      try {
        const out = await call<unknown>(
          "get_subscription",
          `/v1/subscriptions?subscription_id=${encodeURIComponent(subscriptionId)}`,
          undefined,
          "GET"
        );
        return readSubscription(out);
      } catch (e) {
        if (e instanceof BillingProviderError && e.details.status === 404) return null;
        throw e;
      }
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
        data: readCreemEventData(p.eventType, p.object),
      };
      return event;
    },

    planForProduct(productId) {
      for (const plan of PAID_PLANS) {
        for (const interval of BILLING_INTERVALS) {
          if (config.products[plan]?.[interval] === productId) return { plan, interval };
        }
      }
      return null;
    },
  };
}
