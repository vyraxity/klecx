/**
 * @jest-environment node
 *
 * Step 8.5 — billing actions behind the billing page:
 * - resume / change plan act on the caller's own subscription only (401 without a session);
 * - only upgrades are self-service; the client never sends a product id or price;
 * - an upgrade adds the difference of the two allowances once, and the provider's
 *   prorated charge (`subscription.paid` in the same period) grants nothing more;
 * - cancel records the scheduled cancellation and confirms it to the person;
 * - the shared rules: planChangeKind / upgradeOptions, recommendUpgrade, the sign-up intent.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import type { Actor } from "@/server/auth/session";
import { createCreemProvider, type CreemProductIds } from "@/server/billing/creem";
import { setBillingProviderForTests } from "@/server/billing/get-provider";
import { handleBillingWebhook } from "@/server/services/billing-webhook";
import { PLANS } from "@/server/billing/plans";
import { POST as resumeRoute } from "@/app/api/v1/billing/resume/route";
import { POST as changePlanRoute } from "@/app/api/v1/billing/change-plan/route";
import { POST as cancelRoute } from "@/app/api/v1/billing/cancel/route";
import { GET as mySubscriptionRoute } from "@/app/api/v1/me/subscription/route";
import { planChangeKind, upgradeOptions } from "@/lib/billing/plan-changes";
import { isCreditsLow, recommendUpgrade } from "@/lib/billing/upgrade";
import { parseSubscribeIntent, subscribeIntentPath } from "@/lib/billing/intent";

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => ({
  getActor: jest.fn(async () => mockActor),
}));
jest.mock("../server/http/rate-limit", () => ({
  limit: jest.fn(async () => {}),
}));
const mockSendEmail = jest.fn<Promise<{ success: boolean }>, unknown[]>(async () => ({ success: true }));
jest.mock("../server/email/send", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const SECRET = "whsec_test_8_5";
const PRODUCTS: CreemProductIds = {
  LITE: { month: "prod_lite_m", year: "prod_lite_y" },
  STANDARD: { month: "prod_std_m", year: "prod_std_y" },
  PRO: { month: "prod_pro_m", year: "prod_pro_y" },
};
const fetchMock = jest.fn(async () => new Response(JSON.stringify({ id: "sub_x", status: "active" }), { status: 200 }));
const creem = createCreemProvider(
  { apiKey: "creem_test_x", apiBase: "https://test-api.creem.io", webhookSecret: SECRET, products: PRODUCTS },
  fetchMock as unknown as typeof fetch
);

const sfx = Date.now().toString().slice(-7);
const DAY = 24 * 60 * 60 * 1000;
const ids: string[] = [];
const actorFor = (userId: string): Actor => ({ userId, role: "USER", sessionId: `sess_${userId}`, email: `${userId}@example.com` });
const post = (url: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const getSub = () => mySubscriptionRoute(new NextRequest("http://localhost:3000/api/v1/me/subscription"));

async function subscriber(label: string, plan: "LITE" | "STANDARD" | "PRO", interval: "month" | "year", extra: Record<string, unknown> = {}) {
  const userId = `s85_${label}_${sfx}`;
  ids.push(userId);
  await db.user.create({ data: { id: userId, email: `${userId}@example.com`, name: userId, emailVerified: true } });
  const periodStart = new Date(Date.now() - 5 * DAY);
  await db.subscription.create({
    data: {
      userId,
      plan,
      interval,
      status: "ACTIVE",
      providerCustomerId: `cust_${label}_${sfx}`,
      providerSubscriptionId: `sub_${label}_${sfx}`,
      currentPeriodStart: periodStart,
      currentPeriodEnd: new Date(periodStart.getTime() + 30 * DAY),
      lastGrantPeriod: periodStart.toISOString().slice(0, 10),
      ...extra,
    },
  });
  await db.creditAccount.create({ data: { userId, planBalance: 300, allowancePlan: plan, allowanceKey: `creem:paid:t_${label}_${sfx}` } });
  return { userId, subId: `sub_${label}_${sfx}`, periodStart };
}

beforeAll(() => setBillingProviderForTests(creem));
beforeEach(() => {
  fetchMock.mockClear();
  mockActor = null;
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  setBillingProviderForTests(undefined);
  await db.billingEvent.deleteMany({ where: { OR: [{ userId: { in: ids } }, { providerEventId: { startsWith: `evt85_${sfx}` } }] } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.subscription.deleteMany({ where: { userId: { in: ids } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

describe("Step 8.5 — billing actions", () => {
  it("every new endpoint needs a session", async () => {
    expect((await resumeRoute(post("/api/v1/billing/resume"))).status).toBe(401);
    expect((await changePlanRoute(post("/api/v1/billing/change-plan", { plan: "PRO", interval: "month" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upgrade: the server maps the product, adds the difference once, and the prorated charge grants nothing more", async () => {
    const { userId, subId, periodStart } = await subscriber("up", "LITE", "month");
    mockActor = actorFor(userId);

    // The client can't send a product id or a price.
    expect((await changePlanRoute(post("/api/v1/billing/change-plan", { plan: "PRO", interval: "month", productId: "prod_cheap" }))).status).toBe(422);

    const res = await changePlanRoute(post("/api/v1/billing/change-plan", { plan: "STANDARD", interval: "month" }));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://test-api.creem.io/v1/subscriptions/${subId}/upgrade`);
    expect(JSON.parse(String(init.body))).toEqual({ product_id: "prod_std_m", update_behavior: "proration-charge-immediately" });

    const extra = PLANS.STANDARD.credits - PLANS.LITE.credits;
    expect(await db.creditAccount.findUniqueOrThrow({ where: { userId } })).toMatchObject({ planBalance: 300 + extra, allowancePlan: "STANDARD" });
    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ plan: "STANDARD" });

    // The provider then reports the prorated charge: same period, no new allowance.
    const raw = JSON.stringify({
      id: `evt85_${sfx}_1`,
      eventType: "subscription.paid",
      created_at: Date.now(),
      object: {
        id: subId,
        product: { id: "prod_std_m" },
        customer: { id: `cust_up_${sfx}` },
        status: "active",
        current_period_start_date: periodStart.toISOString(),
        current_period_end_date: new Date(periodStart.getTime() + 30 * DAY).toISOString(),
        metadata: { userId },
        last_transaction: { id: `tran85_${sfx}`, amount_paid: 250 },
      },
    });
    expect((await handleBillingWebhook(raw, createHmac("sha256", SECRET).update(raw).digest("hex"), "req85")).status).toBe(200);
    expect((await db.creditAccount.findUniqueOrThrow({ where: { userId } })).planBalance).toBe(300 + extra);
    expect(await db.billingEvent.findFirst({ where: { providerEventId: `evt85_${sfx}_1` } })).toMatchObject({ error: "mid_period_payment" });

    const note = await db.notification.findFirst({ where: { userId, type: "SUBSCRIPTION_CHANGED" } });
    expect(note?.payload).toMatchObject({ kind: "plan_changed", plan: "STANDARD" });
  });

  it("only upgrades are self-service: downgrades, yearly → monthly and the same plan are refused without calling the provider", async () => {
    const { userId } = await subscriber("down", "STANDARD", "year");
    mockActor = actorFor(userId);
    for (const [body, status, code] of [
      [{ plan: "LITE", interval: "year" }, 422, "plan_change_not_supported"],
      [{ plan: "PRO", interval: "month" }, 422, "plan_change_not_supported"],
      [{ plan: "STANDARD", interval: "year" }, 409, "same_plan"],
    ] as const) {
      const res = await changePlanRoute(post("/api/v1/billing/change-plan", body));
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("someone on Free has nothing to change, cancel or resume (404)", async () => {
    const userId = `s85_free_${sfx}`;
    ids.push(userId);
    await db.user.create({ data: { id: userId, email: `${userId}@example.com`, name: userId, emailVerified: true } });
    mockActor = actorFor(userId);
    expect((await changePlanRoute(post("/api/v1/billing/change-plan", { plan: "PRO", interval: "month" }))).status).toBe(404);
    expect((await resumeRoute(post("/api/v1/billing/resume"))).status).toBe(404);
    expect((await cancelRoute(post("/api/v1/billing/cancel", { atPeriodEnd: true }))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancel → resume: recorded at once, cancellation confirmed to the person, resume undoes it", async () => {
    const { userId, subId } = await subscriber("cr", "PRO", "month");
    mockActor = actorFor(userId);

    expect((await resumeRoute(post("/api/v1/billing/resume"))).status).toBe(409); // nothing scheduled

    expect((await cancelRoute(post("/api/v1/billing/cancel", { atPeriodEnd: true }))).status).toBe(200);
    let { data } = await (await getSub()).json();
    expect(data.subscription).toMatchObject({ cancelAtPeriodEnd: true, canResume: true, canCancel: false, canChangePlan: false });
    expect(data.effectivePlan).toBe("PRO");
    expect(await db.notification.findFirst({ where: { userId, type: "SUBSCRIPTION_CHANGED" } })).toMatchObject({
      payload: expect.objectContaining({ kind: "cancel_scheduled" }),
    });

    // A plan change waits until the cancellation is undone.
    expect((await changePlanRoute(post("/api/v1/billing/change-plan", { plan: "PRO", interval: "year" }))).status).toBe(409);

    fetchMock.mockClear();
    expect((await resumeRoute(post("/api/v1/billing/resume"))).status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://test-api.creem.io/v1/subscriptions/${subId}/resume`);
    expect(init.body).toBeUndefined();
    ({ data } = await (await getSub()).json());
    expect(data.subscription).toMatchObject({ cancelAtPeriodEnd: false, canCancel: true, canResume: false, canChangePlan: true });
  });

  it("a failed renewal shows as a payment issue", async () => {
    const { userId } = await subscriber("pd", "LITE", "month", { status: "PAST_DUE" });
    mockActor = actorFor(userId);
    const { data } = await (await getSub()).json();
    expect(data.subscription).toMatchObject({ paymentIssue: true, status: "PAST_DUE" });
    expect(JSON.stringify(data)).not.toMatch(/cust_|sub_/);
  });
});

describe("Step 8.5 — shared rules", () => {
  it("planChangeKind / upgradeOptions", () => {
    expect(planChangeKind({ plan: "LITE", interval: "month" }, { plan: "PRO", interval: "year" })).toBe("upgrade");
    expect(planChangeKind({ plan: "LITE", interval: "month" }, { plan: "LITE", interval: "year" })).toBe("upgrade");
    expect(planChangeKind({ plan: "LITE", interval: "year" }, { plan: "PRO", interval: "month" })).toBe("not_supported");
    expect(planChangeKind({ plan: "PRO", interval: "month" }, { plan: "LITE", interval: "month" })).toBe("not_supported");
    expect(upgradeOptions({ plan: "PRO", interval: "year" })).toEqual([]);
    expect(upgradeOptions({ plan: "FREE", interval: "month" })).toHaveLength(6);
  });

  it("recommendUpgrade picks the cheapest plan that unlocks the thing", () => {
    expect(recommendUpgrade({ code: "requires_plan", plan: "STANDARD" }, "FREE")).toBe("STANDARD");
    const forMembers = recommendUpgrade({ code: "member_limit", limit: PLANS.FREE.limits.members }, "FREE");
    expect(forMembers && PLANS[forMembers].limits.members).toBeGreaterThan(PLANS.FREE.limits.members);
    expect(recommendUpgrade({ code: "out_of_credits" }, "LITE")).toBe("STANDARD");
    expect(recommendUpgrade({ code: "out_of_credits" }, "PRO")).toBeNull();
    // Not the person's to fix.
    expect(recommendUpgrade({ code: "owner_out_of_credits" }, "FREE")).toBeNull();
    expect(recommendUpgrade({ code: "owner_plan", plan: "PRO" }, "FREE")).toBeNull();
    expect(isCreditsLow(20, "FREE")).toBe(true);
    expect(isCreditsLow(21, "FREE")).toBe(false);
  });

  it("the sign-up intent names only a plan and a period", () => {
    expect(parseSubscribeIntent("lite", "year")).toEqual({ plan: "LITE", interval: "year" });
    expect(parseSubscribeIntent("free", "month")).toBeNull();
    expect(parseSubscribeIntent("pro", "weekly")).toEqual({ plan: "PRO", interval: "month" });
    expect(subscribeIntentPath("STANDARD", "month")).toBe("/settings/billing?subscribe=standard&interval=month");
  });
});
