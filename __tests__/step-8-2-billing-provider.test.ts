/**
 * @jest-environment node
 *
 * Step 8.2 — billing provider interface and Creem client.
 * - plan + interval → Creem product id, on the server only;
 * - the Creem client sends the documented paths, header and fields, and turns
 *   Creem errors into `BillingProviderError` (logged, never shown);
 * - webhook signatures (HMAC-SHA256 of the raw body) are verified;
 * - checkout / portal / cancel / `GET /me/subscription` act on the caller's own
 *   subscription only, refuse a second subscription, and surface provider
 *   failures as a generic 503 `billing_unavailable`.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import type { Actor } from "@/server/auth/session";
import { createCreemProvider, creemProductId, type CreemProductIds } from "@/server/billing/creem";
import { creemProductsFromEnv, setBillingProviderForTests } from "@/server/billing/get-provider";
import {
  BillingProviderError,
  WebhookSignatureError,
  type BillingProvider,
  type CreateCheckoutInput,
} from "@/server/billing/provider";
import { validateEnv } from "@/server/env";
import { CHECKOUT_CONSENT_VERSION } from "@/lib/billing/consent";
import { POST as checkoutRoute } from "@/app/api/v1/billing/checkout/route";
import { POST as portalRoute } from "@/app/api/v1/billing/portal/route";
import { POST as cancelRoute } from "@/app/api/v1/billing/cancel/route";
import { GET as mySubscriptionRoute } from "@/app/api/v1/me/subscription/route";
import { log } from "@/server/log";

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => ({
  getActor: jest.fn(async () => mockActor),
}));
jest.mock("../server/http/rate-limit", () => ({
  limit: jest.fn(async () => {}),
}));

const PRODUCTS: CreemProductIds = {
  LITE: { month: "prod_lite_m", year: "prod_lite_y" },
  STANDARD: { month: "prod_std_m", year: "prod_std_y" },
  PRO: { month: "prod_pro_m", year: "prod_pro_y" },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Step 8.2 — product mapping", () => {
  it.each([
    ["LITE", "month", "prod_lite_m"],
    ["LITE", "year", "prod_lite_y"],
    ["STANDARD", "month", "prod_std_m"],
    ["STANDARD", "year", "prod_std_y"],
    ["PRO", "month", "prod_pro_m"],
    ["PRO", "year", "prod_pro_y"],
  ] as const)("%s / %s → %s", (plan, interval, id) => {
    expect(creemProductId(PRODUCTS, plan, interval)).toBe(id);
  });

  it("a missing product is a provider error, not a silent wrong product", () => {
    const partial = { ...PRODUCTS, PRO: { month: "prod_pro_m", year: "" } };
    expect(() => creemProductId(partial, "PRO", "year")).toThrow(BillingProviderError);
  });

  it("billing is off until all six product ids are set", () => {
    const full = {
      CREEM_PRODUCT_LITE_MONTH: "prod_1",
      CREEM_PRODUCT_LITE_YEAR: "prod_2",
      CREEM_PRODUCT_STANDARD_MONTH: "prod_3",
      CREEM_PRODUCT_STANDARD_YEAR: "prod_4",
      CREEM_PRODUCT_PRO_MONTH: "prod_5",
      CREEM_PRODUCT_PRO_YEAR: "prod_6",
    };
    type EnvLike = Parameters<typeof creemProductsFromEnv>[0];
    expect(creemProductsFromEnv(full as unknown as EnvLike)?.PRO.year).toBe("prod_6");
    expect(creemProductsFromEnv({ ...full, CREEM_PRODUCT_PRO_YEAR: undefined } as unknown as EnvLike)).toBeNull();
  });
});

describe("Step 8.2 — env", () => {
  const prodEnv = {
    NODE_ENV: "production",
    APP_URL: "https://klecx.example",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(40),
    GEMINI_API_KEY: "gemini_key_123",
    RESEND_API_KEY: "re_123",
    EMAIL_FROM: "Klecx <hi@klecx.example>",
    SUPPORT_EMAIL: "support@klecx.example",
    PRIVACY_EMAIL: "privacy@klecx.example",
    ABUSE_EMAIL: "abuse@klecx.example",
    COMPANY_LEGAL_NAME: "Vyraxity",
    COMPANY_ADDRESS: "Lagos, Nigeria",
    COMPANY_COUNTRY: "NG",
    UPSTASH_REDIS_REST_URL: "https://redis.example",
    UPSTASH_REDIS_REST_TOKEN: "token",
  };
  const creemEnv = {
    BILLING_PROVIDER: "creem",
    CREEM_API_KEY: "creem_live_key_123",
    CREEM_API_BASE: "https://api.creem.io",
    CREEM_WEBHOOK_SECRET: "whsec_live_123",
    CREEM_PRODUCT_LITE_MONTH: "prod_1",
    CREEM_PRODUCT_LITE_YEAR: "prod_2",
    CREEM_PRODUCT_STANDARD_MONTH: "prod_3",
    CREEM_PRODUCT_STANDARD_YEAR: "prod_4",
    CREEM_PRODUCT_PRO_MONTH: "prod_5",
    CREEM_PRODUCT_PRO_YEAR: "prod_6",
  };

  it("production with billing off needs no Creem settings", () => {
    expect(() => validateEnv({ ...prodEnv, BILLING_ENABLED: "false" })).not.toThrow();
  });

  it("production with billing on needs the provider, key, API base and all six products", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => validateEnv({ ...prodEnv, BILLING_ENABLED: "true" })).toThrow(/CREEM_API_KEY/);
    expect(() =>
      validateEnv({ ...prodEnv, ...creemEnv, CREEM_PRODUCT_PRO_YEAR: "", BILLING_ENABLED: "true" })
    ).toThrow(/CREEM_PRODUCT_PRO_YEAR/);
    expect(() => validateEnv({ ...prodEnv, ...creemEnv, CREEM_PRODUCT_LITE_MONTH: "lite" })).toThrow(
      /CREEM_PRODUCT_LITE_MONTH/
    );
    errorSpy.mockRestore();
    expect(() => validateEnv({ ...prodEnv, ...creemEnv, BILLING_ENABLED: "true" })).not.toThrow();
  });
});

describe("Step 8.2 — Creem client", () => {
  const config = {
    apiKey: "creem_test_key_123",
    apiBase: "https://test-api.creem.io/",
    webhookSecret: "whsec_test_secret",
    products: PRODUCTS,
  };
  const checkoutInput: CreateCheckoutInput = {
    userId: "user_1",
    email: "buyer@example.com",
    plan: "STANDARD",
    interval: "year",
    requestId: "req_1",
    successUrl: "http://localhost:3000/settings?checkout=success",
  };

  it("creates a checkout with the product of plan + interval and our metadata", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(200, { id: "ch_1", checkout_url: "https://checkout.creem.io/ch_1", status: "pending" })
    );
    const creem = createCreemProvider(config, fetchMock as unknown as typeof fetch);
    await expect(creem.createCheckout(checkoutInput)).resolves.toEqual({
      url: "https://checkout.creem.io/ch_1",
      checkoutId: "ch_1",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test-api.creem.io/v1/checkouts");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("creem_test_key_123");
    expect(JSON.parse(String(init.body))).toEqual({
      product_id: "prod_std_y",
      request_id: "req_1",
      success_url: checkoutInput.successUrl,
      customer: { email: "buyer@example.com" },
      metadata: { userId: "user_1", plan: "STANDARD", interval: "year" },
    });
  });

  it("a returning buyer is sent as the existing customer id (Creem takes id or email)", async () => {
    const fetchMock = jest.fn(async () => jsonResponse(200, { id: "ch_2", checkout_url: "https://x/ch_2" }));
    const creem = createCreemProvider(config, fetchMock as unknown as typeof fetch);
    await creem.createCheckout({ ...checkoutInput, customerId: "cust_9" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).customer).toEqual({ id: "cust_9" });
  });

  it("portal link and scheduled cancellation use the documented endpoints", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { customer_portal_link: "https://creem.io/portal/abc" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "sub_1", status: "scheduled_cancel" }));
    const creem = createCreemProvider(config, fetchMock as unknown as typeof fetch);

    await expect(creem.createPortalLink("cust_1")).resolves.toEqual({ url: "https://creem.io/portal/abc" });
    await creem.cancelSubscription("sub_1", { atPeriodEnd: true });

    const [portalUrl, portalInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(portalUrl).toBe("https://test-api.creem.io/v1/customers/billing");
    expect(JSON.parse(String(portalInit.body))).toEqual({ customer_id: "cust_1" });
    const [cancelUrl, cancelInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(cancelUrl).toBe("https://test-api.creem.io/v1/subscriptions/sub_1/cancel");
    expect(JSON.parse(String(cancelInit.body))).toEqual({ mode: "scheduled", onExecute: "cancel" });
  });

  it("a Creem error becomes a BillingProviderError carrying status and trace id", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(400, { trace_id: "trace_123", status: 400, error: "Bad Request", message: ["x"] })
    );
    const creem = createCreemProvider(config, fetchMock as unknown as typeof fetch);
    const err = await creem.createCheckout(checkoutInput).catch((e) => e);
    expect(err).toBeInstanceOf(BillingProviderError);
    expect(err.details).toEqual({ status: 400, traceId: "trace_123" });
  });

  it("a network failure or timeout becomes a BillingProviderError", async () => {
    const fetchMock = jest.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const creem = createCreemProvider(config, fetchMock as unknown as typeof fetch);
    const err = await creem.createPortalLink("cust_1").catch((e) => e);
    expect(err).toBeInstanceOf(BillingProviderError);
    expect(err.details.cause).toBe("TimeoutError");
  });

  describe("webhook signature", () => {
    const creem = createCreemProvider(config, jest.fn() as unknown as typeof fetch);
    const body = JSON.stringify({
      id: "evt_1",
      eventType: "subscription.paid",
      created_at: 1728734327412,
      object: { id: "sub_1" },
    });
    const sign = (raw: string, secret = config.webhookSecret) =>
      createHmac("sha256", secret).update(raw).digest("hex");

    it("accepts a correct signature and normalizes the event", () => {
      const event = creem.verifyWebhook(body, sign(body));
      expect(event).toMatchObject({
        provider: "creem",
        id: "evt_1",
        type: "subscription.paid",
        object: { id: "sub_1" },
      });
      expect(event.createdAt.getTime()).toBe(1728734327412);
    });

    it.each([
      ["missing", null],
      ["wrong secret", sign(body, "another_secret")],
      ["not hex", "zz-not-a-signature"],
      ["signature of another body", sign(body + " ")],
    ])("rejects a %s signature", (_label, signature) => {
      expect(() => creem.verifyWebhook(body, signature)).toThrow(WebhookSignatureError);
    });
  });
});

describe("Step 8.2 — billing endpoints", () => {
  const sfx = Date.now().toString().slice(-7);
  const buyer = `s82_buyer_${sfx}`;
  const subscriber = `s82_sub_${sfx}`;
  const users = [buyer, subscriber];

  const actorFor = (userId: string): Actor => ({
    userId,
    role: "USER",
    sessionId: `sess_${userId}`,
    email: `${userId}@example.com`,
  });

  let calls: { checkout: CreateCheckoutInput[]; portal: string[]; cancel: Array<[string, boolean]> };
  let fail = false;
  const fakeProvider: BillingProvider = {
    name: "fake",
    async createCheckout(input) {
      if (fail) throw new BillingProviderError("checkout", "Creem answered 500", { status: 500, traceId: "t_1" });
      calls.checkout.push(input);
      return { url: `https://checkout.example/${input.plan}-${input.interval}`, checkoutId: "ch_x" };
    },
    async createPortalLink(customerId) {
      calls.portal.push(customerId);
      return { url: `https://portal.example/${customerId}` };
    },
    async cancelSubscription(subscriptionId, { atPeriodEnd }) {
      calls.cancel.push([subscriptionId, atPeriodEnd]);
    },
    verifyWebhook() {
      throw new WebhookSignatureError();
    },
    planForProduct() {
      return null;
    },
    async resumeSubscription() {},
    async changeSubscriptionPlan() {},
  };

  const post = (url: string, body?: unknown) =>
    new NextRequest(`http://localhost:3000${url}`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  beforeAll(async () => {
    await db.subscription.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.user.createMany({
      data: users.map((id) => ({ id, email: `${id}@example.com`, name: id, emailVerified: true })),
    });
    await db.subscription.create({
      data: {
        userId: subscriber,
        plan: "STANDARD",
        interval: "month",
        status: "ACTIVE",
        providerCustomerId: `cust_${sfx}`,
        providerSubscriptionId: `sub_${sfx}`,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    setBillingProviderForTests(undefined);
    await db.subscription.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  });

  beforeEach(() => {
    calls = { checkout: [], portal: [], cancel: [] };
    fail = false;
    mockActor = null;
    setBillingProviderForTests(fakeProvider);
  });

  it("every endpoint needs a session", async () => {
    expect((await checkoutRoute(post("/api/v1/billing/checkout", { plan: "LITE", interval: "month", consentImmediateStart: true }))).status).toBe(401);
    expect((await portalRoute(post("/api/v1/billing/portal"))).status).toBe(401);
    expect((await cancelRoute(post("/api/v1/billing/cancel", { atPeriodEnd: true }))).status).toBe(401);
    expect((await mySubscriptionRoute(new NextRequest("http://localhost:3000/api/v1/me/subscription"))).status).toBe(401);
    expect(calls).toEqual({ checkout: [], portal: [], cancel: [] });
  });

  it("checkout: the server picks the product and sends the caller's id and email", async () => {
    mockActor = actorFor(buyer);
    const res = await checkoutRoute(post("/api/v1/billing/checkout", { plan: "PRO", interval: "year", consentImmediateStart: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ url: "https://checkout.example/PRO-year" });
    expect(calls.checkout).toHaveLength(1);
    expect(calls.checkout[0]).toMatchObject({
      userId: buyer,
      email: `${buyer}@example.com`,
      customerId: null,
      plan: "PRO",
      interval: "year",
      successUrl: "http://localhost:3000/settings/billing?checkout=success",
    });
  });

  it("checkout: the client can't send a product id or price, or buy FREE", async () => {
    mockActor = actorFor(buyer);
    for (const body of [
      { plan: "PRO", interval: "year", productId: "prod_cheap" },
      { plan: "PRO", interval: "year", price: 1 },
      { plan: "FREE", interval: "month" },
      { plan: "PRO", interval: "week" },
    ]) {
      expect((await checkoutRoute(post("/api/v1/billing/checkout", body))).status).toBe(422);
    }
    expect(calls.checkout).toHaveLength(0);
  });

  it("checkout: without the consent to immediate start → 422 and nothing recorded (Step 8.5)", async () => {
    mockActor = actorFor(buyer);
    const before = await db.billingConsent.count({ where: { userId: buyer } });
    for (const body of [{ plan: "PRO", interval: "year" }, { plan: "PRO", interval: "year", consentImmediateStart: false }]) {
      expect((await checkoutRoute(post("/api/v1/billing/checkout", body))).status).toBe(422);
    }
    expect(calls.checkout).toHaveLength(0);
    expect(await db.billingConsent.count({ where: { userId: buyer } })).toBe(before);
  });

  it("checkout: the consent is recorded with the checkout and its wording version", async () => {
    mockActor = actorFor(buyer);
    expect((await checkoutRoute(post("/api/v1/billing/checkout", { plan: "LITE", interval: "year", consentImmediateStart: true }))).status).toBe(200);
    const consent = await db.billingConsent.findFirst({ where: { userId: buyer, kind: "checkout" }, orderBy: { createdAt: "desc" } });
    expect(consent).toMatchObject({ plan: "LITE", interval: "year", version: CHECKOUT_CONSENT_VERSION, checkoutId: calls.checkout[0]?.requestId });
  });

  it("checkout: someone with a paid plan can't start a second subscription", async () => {
    mockActor = actorFor(subscriber);
    const res = await checkoutRoute(post("/api/v1/billing/checkout", { plan: "PRO", interval: "month", consentImmediateStart: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("subscription_exists");
    expect(calls.checkout).toHaveLength(0);
  });

  it("a provider failure is a generic 503 without provider details", async () => {
    mockActor = actorFor(buyer);
    fail = true;
    const errorSpy = jest.spyOn(log, "error").mockImplementation(() => {});
    const res = await checkoutRoute(post("/api/v1/billing/checkout", { plan: "LITE", interval: "month", consentImmediateStart: true }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("billing_unavailable");
    expect(JSON.stringify(body)).not.toContain("t_1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: body.error.requestId, billing: "checkout", traceId: "t_1" })
    );
    errorSpy.mockRestore();
  });

  it("billing not configured → 503 billing_unavailable", async () => {
    mockActor = actorFor(buyer);
    setBillingProviderForTests(null);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await checkoutRoute(post("/api/v1/billing/checkout", { plan: "LITE", interval: "month", consentImmediateStart: true }));
    expect(res.status).toBe(503);
    errorSpy.mockRestore();
  });

  it("portal: opens the caller's own customer portal; without a subscription → 404", async () => {
    mockActor = actorFor(buyer);
    expect((await portalRoute(post("/api/v1/billing/portal"))).status).toBe(404);
    expect(calls.portal).toHaveLength(0);

    mockActor = actorFor(subscriber);
    const res = await portalRoute(post("/api/v1/billing/portal"));
    expect(res.status).toBe(200);
    expect(calls.portal).toEqual([`cust_${sfx}`]);
  });

  it("cancel: only at period end, only the caller's own subscription", async () => {
    mockActor = actorFor(buyer);
    expect((await cancelRoute(post("/api/v1/billing/cancel", { atPeriodEnd: true }))).status).toBe(404);

    mockActor = actorFor(subscriber);
    expect((await cancelRoute(post("/api/v1/billing/cancel", { atPeriodEnd: false }))).status).toBe(422);
    expect((await cancelRoute(post("/api/v1/billing/cancel", { atPeriodEnd: true }))).status).toBe(200);
    expect(calls.cancel).toEqual([[`sub_${sfx}`, true]]);
  });

  it("GET /me/subscription answers for the caller only and hides provider ids", async () => {
    mockActor = actorFor(buyer);
    const none = await (await mySubscriptionRoute(new NextRequest("http://localhost:3000/api/v1/me/subscription"))).json();
    expect(none.data).toEqual({ effectivePlan: "FREE", resetsAt: null, balance: 0, subscription: null });

    mockActor = actorFor(subscriber);
    const res = await mySubscriptionRoute(new NextRequest("http://localhost:3000/api/v1/me/subscription"));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { data } = await res.json();
    expect(data).toMatchObject({
      effectivePlan: "STANDARD",
      // The cancel test above scheduled a cancellation; Step 8.5 records it once the provider confirms.
      subscription: { plan: "STANDARD", interval: "month", status: "ACTIVE", cancelAtPeriodEnd: true, canManage: true, canResume: true, canCancel: false },
    });
    expect(JSON.stringify(data)).not.toMatch(/cust_|sub_/);
  });
});
