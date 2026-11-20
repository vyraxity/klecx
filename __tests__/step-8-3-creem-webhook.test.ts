/**
 * @jest-environment node
 *
 * Step 8.3 — Creem webhook: signature, idempotency, state machine.
 * Required by the guide:
 * - forged / missing signature → 401 and no DB writes;
 * - the same event delivered 3× → one credit grant;
 * - `paid` arriving before `active` still ends ACTIVE with one grant;
 * - `refund.created` never drives a balance negative;
 * - `dispute.created` blocks generation;
 * - handler exception → 500, and the retry succeeds without duplicates.
 * Plus: the person is found by request_id / metadata, never by email; unknown
 * events are stored as IGNORED; stale events don't undo newer state; a full
 * refund ends the plan and cancels at the provider; collaborator limits follow
 * plan changes (F1.3).
 */
import { createHmac } from "node:crypto";
import { db } from "@/server/db/client";
import { createCreemProvider, readCreemEventData, type CreemProductIds } from "@/server/billing/creem";
import { setBillingProviderForTests } from "@/server/billing/get-provider";
import type { BillingProvider } from "@/server/billing/provider";
import { handleBillingWebhook } from "@/server/services/billing-webhook";
import { createAccountWithFreeGrant, reserve } from "@/server/services/credits";
import { getEntitlements } from "@/server/billing/entitlements";
import { PLANS } from "@/server/billing/plans";
import { POST as webhookRoute } from "@/app/api/webhooks/creem/route";

const mockSendEmail = jest.fn<Promise<{ success: boolean }>, unknown[]>(async () => ({ success: true }));
jest.mock("../server/email/send", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const SECRET = "whsec_test_8_3";
const PRODUCTS: CreemProductIds = {
  LITE: { month: "prod_lite_m", year: "prod_lite_y" },
  STANDARD: { month: "prod_std_m", year: "prod_std_y" },
  PRO: { month: "prod_pro_m", year: "prod_pro_y" },
};

const cancelCalls: Array<[string, boolean]> = [];
let failNextHandler = false;
const creem = createCreemProvider({ apiKey: "creem_test_x", apiBase: "https://test-api.creem.io", webhookSecret: SECRET, products: PRODUCTS }, jest.fn() as unknown as typeof fetch);
const provider: BillingProvider = {
  ...creem,
  verifyWebhook: creem.verifyWebhook,
  planForProduct(productId) {
    if (failNextHandler) {
      failNextHandler = false;
      throw new Error("simulated handler failure");
    }
    return creem.planForProduct(productId);
  },
  async cancelSubscription(id, { atPeriodEnd }) {
    cancelCalls.push([id, atPeriodEnd]);
  },
};

const sfx = Date.now().toString().slice(-7);
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const ids: string[] = [];

function sign(raw: string, secret = SECRET) {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

async function deliver(payload: Record<string, unknown>, signature?: string | null) {
  const raw = JSON.stringify(payload);
  return handleBillingWebhook(raw, signature === undefined ? sign(raw) : signature, "req_test");
}

function envelope(eventType: string, object: Record<string, unknown>, at: number, id = `evt_${sfx}_${++seq}`) {
  return { id, eventType, created_at: at, object };
}

type SubOpts = {
  subId: string;
  customerId: string;
  userId?: string;
  product?: string;
  status?: string;
  periodStart?: Date;
  periodEnd?: Date;
  transactionId?: string;
  amountPaid?: number;
};

function subscriptionObject(o: SubOpts) {
  const start = o.periodStart ?? new Date(Date.now() - DAY);
  const end = o.periodEnd ?? new Date(start.getTime() + 30 * DAY);
  return {
    id: o.subId,
    object: "subscription",
    product: { id: o.product ?? "prod_std_m", object: "product" },
    customer: { id: o.customerId, object: "customer", email: "someone@example.com" },
    status: o.status ?? "active",
    current_period_start_date: start.toISOString(),
    current_period_end_date: end.toISOString(),
    canceled_at: null,
    metadata: o.userId ? { userId: o.userId, plan: "STANDARD", interval: "month" } : {},
    ...(o.transactionId
      ? { last_transaction: { id: o.transactionId, object: "transaction", amount: o.amountPaid ?? 2000, amount_paid: o.amountPaid ?? 2000, status: "paid" } }
      : {}),
    mode: "test",
  };
}

async function makeUser(label: string) {
  const id = `s83_${label}_${sfx}`;
  ids.push(id);
  await db.user.create({ data: { id, email: `${id}@example.com`, name: id, emailVerified: true } });
  await createAccountWithFreeGrant(id);
  return id;
}

async function balance(userId: string) {
  const acc = await db.creditAccount.findUniqueOrThrow({ where: { userId } });
  return acc.planBalance;
}

async function grants(userId: string) {
  return db.creditLedger.count({
    where: { account: { userId }, type: "GRANT", reason: "subscription.paid" },
  });
}

async function eventRow(id: string) {
  return db.billingEvent.findUnique({ where: { provider_providerEventId: { provider: "creem", providerEventId: id } } });
}

async function cleanup() {
  if (ids.length === 0) return;
  await db.billingEvent.deleteMany({ where: { OR: [{ userId: { in: ids } }, { providerEventId: { startsWith: `evt_${sfx}_` } }] } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.memberLimitGrace.deleteMany({ where: { ownerId: { in: ids } } });
  await db.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
  await db.workspace.deleteMany({ where: { ownerId: { in: ids } } });
  await db.subscription.deleteMany({ where: { userId: { in: ids } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(() => setBillingProviderForTests(provider));
afterAll(async () => {
  setBillingProviderForTests(undefined);
  await cleanup();
});
beforeEach(() => {
  mockSendEmail.mockClear();
  cancelCalls.length = 0;
  failNextHandler = false;
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("Step 8.3 — Creem payload reading", () => {
  it("reads checkout, subscription, refund and dispute fields (expanded or bare ids)", () => {
    const checkout = readCreemEventData("checkout.completed", {
      id: "ch_1",
      request_id: "req_1",
      customer: { id: "cust_1" },
      subscription: { id: "sub_1", status: "active", product: "prod_std_m" },
      order: { transaction: "tran_1" },
      metadata: { userId: "u_1", plan: "STANDARD", interval: "month" },
    });
    expect(checkout).toMatchObject({
      requestId: "req_1",
      metadataUserId: "u_1",
      customerId: "cust_1",
      subscription: { id: "sub_1", status: "active", productId: "prod_std_m" },
      transaction: { id: "tran_1" },
    });

    const refund = readCreemEventData("refund.created", {
      id: "ref_1",
      refund_amount: 1210,
      reason: "requested_by_customer",
      transaction: { id: "tran_2", amount_paid: 2420, refunded_amount: 1210 },
      subscription: "sub_2",
      checkout: { id: "ch_2", request_id: "req_2" },
      customer: "cust_2",
    });
    expect(refund).toMatchObject({
      requestId: "req_2",
      customerId: "cust_2",
      subscription: { id: "sub_2" },
      transaction: { id: "tran_2", amountPaid: 2420, refundedAmount: 1210 },
      refund: { id: "ref_1", amount: 1210, reason: "requested_by_customer" },
    });

    expect(readCreemEventData("dispute.created", { id: "disp_1", subscription: { id: "sub_3" } })).toMatchObject({
      dispute: { id: "disp_1" },
      subscription: { id: "sub_3" },
    });
  });

  it("maps product ids back to plan and interval", () => {
    expect(creem.planForProduct("prod_pro_y")).toEqual({ plan: "PRO", interval: "year" });
    expect(creem.planForProduct("prod_unknown")).toBeNull();
  });
});

describe("Step 8.3 — webhook endpoint", () => {
  it("forged or missing signature → 401 and nothing is written", async () => {
    const userId = await makeUser("forged");
    const payload = envelope("subscription.paid", subscriptionObject({ subId: `sub_f_${sfx}`, customerId: `cust_f_${sfx}`, userId, transactionId: `tran_f_${sfx}` }), Date.now());

    expect((await deliver(payload, null)).status).toBe(401);
    expect((await deliver(payload, sign(JSON.stringify(payload), "attacker_secret"))).status).toBe(401);
    expect((await deliver(payload, "deadbeef")).status).toBe(401);

    expect(await eventRow(payload.id)).toBeNull();
    expect(await db.subscription.findUnique({ where: { userId } })).toBeNull();
    expect(await grants(userId)).toBe(0);
  });

  it("the route reads the raw body and the creem-signature header", async () => {
    const payload = envelope("customer.updated_unknown", {}, Date.now());
    const raw = JSON.stringify(payload);
    const ok = await webhookRoute(new Request("http://localhost:3000/api/webhooks/creem", { method: "POST", body: raw, headers: { "creem-signature": sign(raw) } }));
    expect(ok.status).toBe(200);
    const bad = await webhookRoute(new Request("http://localhost:3000/api/webhooks/creem", { method: "POST", body: raw }));
    expect(bad.status).toBe(401);
  });

  it("unknown event types are stored as IGNORED and answered 200", async () => {
    const payload = envelope("credits.granted", { id: "x" }, Date.now());
    expect((await deliver(payload)).status).toBe(200);
    expect(await eventRow(payload.id)).toMatchObject({ status: "IGNORED", error: "unhandled_event_type" });
  });

  it("checkout + the same paid event 3× → ACTIVE with exactly one grant", async () => {
    const userId = await makeUser("buyer");
    const subId = `sub_b_${sfx}`;
    const customerId = `cust_b_${sfx}`;
    await db.billingCheckout.create({ data: { id: `req_b_${sfx}`, userId, plan: "STANDARD", interval: "month" } });
    const t0 = Date.now();

    const checkout = envelope(
      "checkout.completed",
      { id: `ch_b_${sfx}`, object: "checkout", request_id: `req_b_${sfx}`, customer: { id: customerId }, subscription: subscriptionObject({ subId, customerId }), metadata: {} },
      t0
    );
    expect((await deliver(checkout)).status).toBe(200);
    expect(await grants(userId)).toBe(0); // no credits before payment

    const paid = envelope("subscription.paid", subscriptionObject({ subId, customerId, userId, transactionId: `tran_b_${sfx}` }), t0 + 1000);
    for (let i = 0; i < 3; i++) expect((await deliver(paid)).status).toBe(200);
    // Concurrent duplicates too.
    await Promise.all([deliver(paid), deliver(paid)]);

    expect(await grants(userId)).toBe(1);
    expect(await balance(userId)).toBe(PLANS.STANDARD.credits);
    const sub = await db.subscription.findUniqueOrThrow({ where: { userId } });
    expect(sub).toMatchObject({ plan: "STANDARD", interval: "month", status: "ACTIVE", providerCustomerId: customerId, providerSubscriptionId: subId });
    expect((await getEntitlements(userId)).plan).toBe("STANDARD");
    expect(await eventRow(paid.id)).toMatchObject({ status: "PROCESSED", userId });

    const notes = await db.notification.findMany({ where: { userId, type: "SUBSCRIPTION_CHANGED" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.payload).toMatchObject({ kind: "activated" });

    // A renewal (new payment) grants again; leftovers expire, no rollover.
    const renewal = envelope(
      "subscription.paid",
      subscriptionObject({ subId, customerId, userId, transactionId: `tran_b2_${sfx}`, periodStart: new Date(t0 + 30 * DAY) }),
      t0 + 2000
    );
    expect((await deliver(renewal)).status).toBe(200);
    expect(await grants(userId)).toBe(2);
    expect(await balance(userId)).toBe(PLANS.STANDARD.credits);
  });

  it("paid before active still ends ACTIVE with one grant", async () => {
    const userId = await makeUser("order");
    const subId = `sub_o_${sfx}`;
    const customerId = `cust_o_${sfx}`;
    const t0 = Date.now();
    const paid = envelope("subscription.paid", subscriptionObject({ subId, customerId, userId, product: "prod_lite_y", transactionId: `tran_o_${sfx}` }), t0 + 500);
    const active = envelope("subscription.active", subscriptionObject({ subId, customerId, userId, product: "prod_lite_y" }), t0);

    expect((await deliver(paid)).status).toBe(200);
    expect((await deliver(active)).status).toBe(200);

    const sub = await db.subscription.findUniqueOrThrow({ where: { userId } });
    expect(sub).toMatchObject({ status: "ACTIVE", plan: "LITE", interval: "year" });
    expect(await grants(userId)).toBe(1);
    expect(await eventRow(active.id)).toMatchObject({ status: "IGNORED", error: "stale_event" });
  });

  it("a stale event doesn't undo a newer scheduled cancellation", async () => {
    const userId = await makeUser("stale");
    const subId = `sub_s_${sfx}`;
    const customerId = `cust_s_${sfx}`;
    const t0 = Date.now();
    await deliver(envelope("subscription.paid", subscriptionObject({ subId, customerId, userId, transactionId: `tran_s_${sfx}` }), t0));
    await deliver(envelope("subscription.scheduled_cancel", subscriptionObject({ subId, customerId, userId, status: "scheduled_cancel" }), t0 + 2000));
    await deliver(envelope("subscription.update", subscriptionObject({ subId, customerId, userId, status: "active" }), t0 + 1000));

    const sub = await db.subscription.findUniqueOrThrow({ where: { userId } });
    expect(sub).toMatchObject({ status: "ACTIVE", cancelAtPeriodEnd: true });
    expect((await getEntitlements(userId)).plan).toBe("STANDARD"); // until the period end

    // The cancellation taking effect at the period end.
    await deliver(envelope("subscription.canceled", subscriptionObject({ subId, customerId, userId, status: "canceled" }), t0 + 3000));
    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "CANCELED", cancelAtPeriodEnd: true });
  });

  it("past_due notifies a failed payment; an immediate cancellation ends the plan now", async () => {
    const userId = await makeUser("pastdue");
    const subId = `sub_p_${sfx}`;
    const customerId = `cust_p_${sfx}`;
    const t0 = Date.now();
    await deliver(envelope("subscription.paid", subscriptionObject({ subId, customerId, userId, transactionId: `tran_p_${sfx}` }), t0));
    await deliver(envelope("subscription.past_due", subscriptionObject({ subId, customerId, userId, status: "past_due" }), t0 + 1000));
    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "PAST_DUE" });
    expect(await db.notification.count({ where: { userId, type: "PAYMENT_FAILED" } })).toBe(1);

    await deliver(envelope("subscription.canceled", subscriptionObject({ subId, customerId, userId, status: "canceled" }), t0 + 2000));
    expect((await getEntitlements(userId)).plan).toBe("FREE");
    const ended = await db.notification.findMany({ where: { userId, type: "SUBSCRIPTION_CHANGED" }, orderBy: { createdAt: "desc" } });
    expect(ended[0]?.payload).toMatchObject({ kind: "ended" });
  });

  it("finds the person by request_id or metadata, never by email", async () => {
    const userId = await makeUser("email");
    const payload = envelope(
      "subscription.paid",
      { ...subscriptionObject({ subId: `sub_e_${sfx}`, customerId: `cust_e_${sfx}`, transactionId: `tran_e_${sfx}` }), customer: { id: `cust_e_${sfx}`, email: `${userId}@example.com` } },
      Date.now()
    );
    expect((await deliver(payload)).status).toBe(200);
    expect(await eventRow(payload.id)).toMatchObject({ status: "IGNORED", error: "user_not_found" });
    expect(await db.subscription.findUnique({ where: { userId } })).toBeNull();
    expect(mockSendEmail).toHaveBeenCalledWith("billing-alert", expect.any(String), expect.objectContaining({ reason: "user_not_found" }));
  });

  it("handler exception → 500 (FAILED), and the retry succeeds without duplicates", async () => {
    const userId = await makeUser("retry");
    const payload = envelope("subscription.paid", subscriptionObject({ subId: `sub_r_${sfx}`, customerId: `cust_r_${sfx}`, userId, transactionId: `tran_r_${sfx}` }), Date.now());

    failNextHandler = true;
    expect((await deliver(payload)).status).toBe(500);
    expect(await eventRow(payload.id)).toMatchObject({ status: "FAILED" });
    expect(await grants(userId)).toBe(0);
    expect(await db.subscription.findUnique({ where: { userId } })).toBeNull();

    expect((await deliver(payload)).status).toBe(200);
    expect((await deliver(payload)).status).toBe(200);
    expect(await eventRow(payload.id)).toMatchObject({ status: "PROCESSED", error: null });
    expect(await grants(userId)).toBe(1);
    expect(await db.billingEvent.count({ where: { providerEventId: payload.id } })).toBe(1);
  });

  it("refund.created never drives the balance negative; a full refund ends the plan and cancels at the provider", async () => {
    const userId = await makeUser("refund");
    const subId = `sub_rf_${sfx}`;
    const customerId = `cust_rf_${sfx}`;
    const t0 = Date.now();
    await deliver(envelope("subscription.paid", subscriptionObject({ subId, customerId, userId, transactionId: `tran_rf_${sfx}`, amountPaid: 2000 }), t0));
    expect(await balance(userId)).toBe(PLANS.STANDARD.credits);

    // Partial refund (25 %): a quarter of the grant is taken back.
    await deliver(envelope("refund.created", { id: `ref_a_${sfx}`, refund_amount: 500, reason: "service_issue", transaction: { id: `tran_rf_${sfx}`, amount_paid: 2000, refunded_amount: 500 }, subscription: subId, customer: customerId }, t0 + 1000));
    expect(await balance(userId)).toBe(PLANS.STANDARD.credits - Math.floor(PLANS.STANDARD.credits / 4));
    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "ACTIVE" });
    expect(cancelCalls).toEqual([]);

    // The person spends almost everything, then the rest is refunded.
    await db.creditAccount.update({ where: { userId }, data: { planBalance: 7 } });
    const full = envelope("refund.created", { id: `ref_b_${sfx}`, refund_amount: 1500, reason: "requested_by_customer", transaction: { id: `tran_rf_${sfx}`, amount_paid: 2000, refunded_amount: 2000 }, subscription: { id: subId }, customer: customerId }, t0 + 2000);
    expect((await deliver(full)).status).toBe(200);
    await deliver(full);

    expect(await balance(userId)).toBe(0);
    const refunds = await db.creditLedger.findMany({ where: { account: { userId }, type: "REFUND" } });
    expect(refunds).toHaveLength(2);
    expect(refunds.every((r) => r.planAfter >= 0)).toBe(true);
    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "CANCELED", cancelAtPeriodEnd: false });
    expect((await getEntitlements(userId)).plan).toBe("FREE");
    expect(cancelCalls).toEqual([[subId, false]]);
  });

  it("dispute.created freezes the account: generation is refused", async () => {
    const userId = await makeUser("dispute");
    const subId = `sub_d_${sfx}`;
    const customerId = `cust_d_${sfx}`;
    const t0 = Date.now();
    await deliver(envelope("subscription.paid", subscriptionObject({ subId, customerId, userId, transactionId: `tran_d_${sfx}` }), t0));
    await deliver(envelope("dispute.created", { id: `disp_${sfx}`, amount: 2000, currency: "USD", transaction: { id: `tran_d_${sfx}` }, subscription: { id: subId }, customer: { id: customerId } }, t0 + 1000));

    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "DISPUTED" });
    expect((await getEntitlements(userId)).generationBlocked).toBe(true);
    const account = await db.creditAccount.findUniqueOrThrow({ where: { userId } });
    await expect(reserve(account.id, 5, `s83_gen_${sfx}`, { generationId: `gen_${sfx}` })).rejects.toMatchObject({ code: "billing_frozen" });
    expect(mockSendEmail).toHaveBeenCalledWith("billing-alert", expect.any(String), expect.objectContaining({ reason: "dispute_created", userId }));

    // A later provider status doesn't lift the dispute.
    await deliver(envelope("subscription.update", subscriptionObject({ subId, customerId, userId, status: "active" }), t0 + 2000));
    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "DISPUTED" });
  });

  it("collaborator limits follow the plan: an ended plan starts the grace, a new subscription restores", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const ws = await db.workspace.create({ data: { ownerId: owner, title: "Team" } });
    await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: member, role: "EDITOR", invitedById: owner } });
    const customerId = `cust_m_${sfx}`;
    const t0 = Date.now();

    await deliver(envelope("subscription.paid", subscriptionObject({ subId: `sub_m1_${sfx}`, customerId, userId: owner, transactionId: `tran_m1_${sfx}` }), t0));
    expect(await db.memberLimitGrace.findUnique({ where: { ownerId: owner } })).toBeNull();

    await deliver(envelope("subscription.canceled", subscriptionObject({ subId: `sub_m1_${sfx}`, customerId, userId: owner, status: "canceled" }), t0 + 1000));
    expect(await db.memberLimitGrace.findUnique({ where: { ownerId: owner } })).toMatchObject({ limit: 0 });

    // A new subscription replaces the ended one and lifts the grace.
    await deliver(envelope("subscription.paid", subscriptionObject({ subId: `sub_m2_${sfx}`, customerId, userId: owner, transactionId: `tran_m2_${sfx}` }), t0 + 2000));
    expect(await db.subscription.findUniqueOrThrow({ where: { userId: owner } })).toMatchObject({ providerSubscriptionId: `sub_m2_${sfx}`, status: "ACTIVE", cancelAtPeriodEnd: false });
    expect(await db.memberLimitGrace.findUnique({ where: { ownerId: owner } })).toBeNull();
  });
});
