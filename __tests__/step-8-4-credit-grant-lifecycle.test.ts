/**
 * @jest-environment node
 *
 * Step 8.4 — credit grant lifecycle. Time-travel tests (a fixed `now`):
 * month rollover, yearly month 7, downgrade at period end, repeated calls in
 * the same period granting once. Plus: reserve() grants first, the member
 * limit is enforced once after the grace, refund eligibility per rule, a
 * refund arriving before its payment, and the support ticket's refund check.
 */
import { createHmac } from "node:crypto";
import { db } from "@/server/db/client";
import {
  addMonthsUTC,
  decideGrant,
  ensureCurrentGrant,
  freeGrantKey,
  freePeriod,
  yearlyMonthIndex,
  type GrantState,
} from "@/server/billing/grants";
import { getRefundEligibility } from "@/server/billing/refunds";
import { PLANS } from "@/server/billing/plans";
import { reserve } from "@/server/services/credits";
import { createCreemProvider, type CreemProductIds } from "@/server/billing/creem";
import { setBillingProviderForTests } from "@/server/billing/get-provider";
import type { BillingProvider } from "@/server/billing/provider";
import { handleBillingWebhook } from "@/server/services/billing-webhook";
import { createSupportTicket } from "@/server/services/support";

const mockSendEmail = jest.fn<Promise<{ success: boolean }>, unknown[]>(async () => ({ success: true }));
jest.mock("../server/email/send", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const DAY = 24 * 60 * 60 * 1000;
const d = (iso: string) => new Date(iso);
const sfx = Date.now().toString().slice(-7);
const ids: string[] = [];

beforeEach(() => {
  mockSendEmail.mockClear();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  setBillingProviderForTests(undefined);
  await db.billingEvent.deleteMany({ where: { OR: [{ userId: { in: ids } }, { providerEventId: { startsWith: `evt84_${sfx}` } }] } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.supportTicket.deleteMany({ where: { userId: { in: ids } } });
  await db.memberLimitGrace.deleteMany({ where: { ownerId: { in: ids } } });
  await db.workspaceMember.deleteMany({ where: { userId: { in: ids } } });
  await db.workspace.deleteMany({ where: { ownerId: { in: ids } } });
  await db.subscription.deleteMany({ where: { userId: { in: ids } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

// ---------------------------------------------------------------- pure rules

const baseState = (over: Partial<GrantState> = {}): GrantState => ({
  userId: "u1",
  signedUpAt: d("2026-03-10T15:00:00Z"),
  emailVerified: true,
  deleted: false,
  allowancePlan: "FREE",
  allowanceKey: "free:u1:2026-10-10",
  subscription: null,
  ...over,
});

const sub = (over: Partial<NonNullable<GrantState["subscription"]>> = {}): NonNullable<GrantState["subscription"]> => ({
  id: "s1",
  plan: "STANDARD",
  interval: "month",
  status: "ACTIVE",
  providerSubscriptionId: "sub_1",
  currentPeriodStart: d("2026-11-05T10:00:00Z"),
  currentPeriodEnd: d("2026-12-05T10:00:00Z"),
  cancelAtPeriodEnd: false,
  lastEventAt: null,
  ...over,
});

describe("Step 8.4 — grant rules (fake clock)", () => {
  it("Free: renews monthly on the sign-up date; not before", () => {
    const renewal = d("2026-11-10T15:00:00Z");
    expect(decideGrant(baseState(), renewal).decision).toEqual({ kind: "free_monthly", key: "free:u1:2026-11-10", amount: PLANS.FREE.credits });
    expect(decideGrant(baseState(), d("2026-11-10T14:59:59Z")).decision.kind).toBe("none");
    expect(decideGrant(baseState(), renewal).resetsAt).toEqual(d("2026-12-10T15:00:00Z"));
    expect(decideGrant(baseState({ allowanceKey: "free:u1:2026-11-10" }), d("2026-12-10T14:00:00Z")).decision.kind).toBe("none");
    // Year rollover.
    expect(decideGrant(baseState({ allowanceKey: "free:u1:2026-12-10" }), d("2027-01-10T16:00:00Z")).decision).toMatchObject({ key: "free:u1:2027-01-10" });
    // Signed up on the 31st: renews on the month's last day.
    const late = baseState({ signedUpAt: d("2026-01-31T00:00:00Z"), allowanceKey: "free:u1:2026-01-31" });
    expect(decideGrant(late, d("2026-02-28T00:00:00Z")).decision).toMatchObject({ key: "free:u1:2026-02-28" });
    expect(decideGrant(late, d("2026-02-28T00:00:00Z")).resetsAt).toEqual(d("2026-03-31T00:00:00Z"));
  });

  it("Free: unverified or deleted accounts get no monthly grant; unstamped accounts are stamped", () => {
    const now = d("2026-11-12T00:00:00Z");
    expect(decideGrant(baseState({ emailVerified: false }), now).decision.kind).toBe("none");
    expect(decideGrant(baseState({ deleted: true }), now).decision.kind).toBe("none");
    expect(decideGrant(baseState({ allowanceKey: null }), now).decision).toEqual({ kind: "stamp", key: "free:u1:2026-11-10" });
  });

  it("paid monthly: nothing lazily (the webhook grants); resets at the period end", () => {
    const r = decideGrant(baseState({ allowancePlan: "STANDARD", allowanceKey: "creem:paid:t1", subscription: sub() }), d("2026-11-20T00:00:00Z"));
    expect(r.decision.kind).toBe("none");
    expect(r.resetsAt).toEqual(d("2026-12-05T10:00:00Z"));
  });

  it("yearly month 7: one allowance per month since the period start", () => {
    const start = d("2026-01-15T08:00:00Z");
    const yearly = sub({ interval: "year", currentPeriodStart: start, currentPeriodEnd: d("2027-01-15T08:00:00Z") });
    const now = d("2026-08-20T00:00:00Z");
    expect(yearlyMonthIndex(start, now)).toBe(7);
    const r = decideGrant(baseState({ allowancePlan: "STANDARD", allowanceKey: "yearly:sub_1:2026-01-15:6", subscription: yearly }), now);
    expect(r.decision).toEqual({ kind: "yearly_monthly", key: "yearly:sub_1:2026-01-15:7", amount: PLANS.STANDARD.credits, plan: "STANDARD" });
    expect(r.resetsAt).toEqual(d("2026-09-15T08:00:00Z"));
    // Already granted this month → nothing.
    expect(decideGrant(baseState({ allowancePlan: "STANDARD", allowanceKey: "yearly:sub_1:2026-01-15:7", subscription: yearly }), now).decision.kind).toBe("none");
    // Month 0 is the webhook's grant.
    expect(decideGrant(baseState({ allowancePlan: "STANDARD", allowanceKey: "creem:paid:t1", subscription: yearly }), d("2026-02-01T00:00:00Z")).decision.kind).toBe("none");
    // After the period end: wait for the renewal.
    expect(decideGrant(baseState({ allowancePlan: "STANDARD", subscription: { ...yearly, status: "PAST_DUE" } }), d("2027-01-16T00:00:00Z")).decision.kind).toBe("none");
  });

  it("month boundaries clamp to the month's end (Jan 31 → Feb 28)", () => {
    expect(addMonthsUTC(d("2026-01-31T12:00:00Z"), 1)).toEqual(d("2026-02-28T12:00:00Z"));
    expect(yearlyMonthIndex(d("2026-01-31T12:00:00Z"), d("2026-02-28T12:00:00Z"))).toBe(1);
    expect(yearlyMonthIndex(d("2026-01-31T12:00:00Z"), d("2026-02-28T11:59:59Z"))).toBe(0);
  });

  it("downgrade at period end: the paid allowance ends only once the period is over", () => {
    const canceled = sub({ status: "CANCELED", cancelAtPeriodEnd: true });
    const state = baseState({ allowancePlan: "STANDARD", allowanceKey: "creem:paid:t1", subscription: canceled });
    expect(decideGrant(state, d("2026-12-05T09:59:59Z")).decision.kind).toBe("none");
    expect(decideGrant(state, d("2026-12-05T10:00:00Z")).decision).toMatchObject({ kind: "plan_ended", freeKey: "free:u1:2026-11-10", previousPlan: "STANDARD" });
    // A past-due plan ends 3 days after the period end, without any webhook.
    const pastDue = baseState({ allowancePlan: "PRO", subscription: sub({ plan: "PRO", status: "PAST_DUE" }) });
    expect(decideGrant(pastDue, d("2026-12-07T00:00:00Z")).decision.kind).toBe("none");
    expect(decideGrant(pastDue, d("2026-12-08T11:00:00Z")).decision.kind).toBe("plan_ended");
  });
});

// ---------------------------------------------------------------- database

async function makeUser(label: string, opts: { verified?: boolean; createdAt?: Date } = {}) {
  const id = `s84_${label}_${sfx}`;
  ids.push(id);
  await db.user.create({
    data: { id, email: `${id}@example.com`, name: id, emailVerified: opts.verified ?? true, ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) },
  });
  return id;
}

/** Key of the Free period the user is in now. */
async function currentFreeKey(userId: string) {
  const { createdAt } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
  return freeGrantKey(userId, freePeriod(createdAt, new Date()).start);
}

async function makeAccount(userId: string, data: { planBalance: number; allowancePlan?: "FREE" | "LITE" | "STANDARD" | "PRO"; allowanceKey?: string | null; topupBalance?: number }) {
  return db.creditAccount.create({
    data: {
      userId,
      planBalance: data.planBalance,
      topupBalance: data.topupBalance ?? 0,
      allowancePlan: data.allowancePlan ?? "FREE",
      allowanceKey: data.allowanceKey ?? null,
    },
  });
}

const balanceOf = async (accountId: string) =>
  db.creditAccount.findUniqueOrThrow({ where: { id: accountId }, select: { planBalance: true, topupBalance: true, allowancePlan: true, allowanceKey: true } });

describe("Step 8.4 — ensureCurrentGrant", () => {
  it("Free renewal on the sign-up date: expires leftovers, grants once, even with concurrent calls; top-ups untouched", async () => {
    const userId = await makeUser("free", { createdAt: d("2026-09-15T12:00:00Z") });
    const acc = await makeAccount(userId, { planBalance: 37, topupBalance: 5, allowanceKey: `free:${userId}:2026-10-15` });
    const now = d("2026-11-16T00:00:00Z");

    const results = await Promise.all([ensureCurrentGrant(acc.id, now), ensureCurrentGrant(acc.id, now), ensureCurrentGrant(acc.id, now)]);
    expect(results.filter((r) => r.action === "free_monthly")).toHaveLength(1);
    expect(results[0]?.resetsAt).toEqual(d("2026-12-15T12:00:00Z"));
    await ensureCurrentGrant(acc.id, d("2026-12-15T11:59:59Z"));

    expect(await balanceOf(acc.id)).toMatchObject({ planBalance: PLANS.FREE.credits, topupBalance: 5, allowanceKey: `free:${userId}:2026-11-15` });
    const ledger = await db.creditLedger.findMany({ where: { accountId: acc.id }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((l) => [l.type, l.planDelta])).toEqual([["EXPIRE", -37], ["GRANT", PLANS.FREE.credits]]);
  });

  it("an unverified account gets no monthly grant", async () => {
    const userId = await makeUser("unverified", { verified: false });
    const acc = await makeAccount(userId, { planBalance: 3, allowanceKey: `free:${userId}:2000-01-01` });
    await ensureCurrentGrant(acc.id);
    expect((await balanceOf(acc.id)).planBalance).toBe(3);
  });

  it("yearly plan, month 7: grants the plan allowance once", async () => {
    const userId = await makeUser("yearly");
    const start = d("2026-01-15T08:00:00Z");
    await db.subscription.create({
      data: { userId, plan: "STANDARD", interval: "year", status: "ACTIVE", providerSubscriptionId: `sub84_y_${sfx}`, currentPeriodStart: start, currentPeriodEnd: d("2027-01-15T08:00:00Z") },
    });
    const acc = await makeAccount(userId, { planBalance: 12, allowancePlan: "STANDARD", allowanceKey: `yearly:sub84_y_${sfx}:2026-01-15:6` });
    const now = d("2026-08-20T00:00:00Z");

    expect((await ensureCurrentGrant(acc.id, now)).action).toBe("yearly_monthly");
    expect((await ensureCurrentGrant(acc.id, now)).action).toBe("none");
    expect(await balanceOf(acc.id)).toMatchObject({ planBalance: PLANS.STANDARD.credits, allowancePlan: "STANDARD" });
    expect(await db.creditLedger.count({ where: { accountId: acc.id, type: "GRANT" } })).toBe(1);
  });

  it("plan ended at the period end: paid credits expire, Free starts (0 if this Free period's credits were already given), and the collaborator grace starts", async () => {
    const owner = await makeUser("ended");
    const member = await makeUser("ended_member");
    const ws = await db.workspace.create({ data: { ownerId: owner, title: "Team" } });
    await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: member, role: "EDITOR", invitedById: owner } });
    await db.subscription.create({
      data: { userId: owner, plan: "STANDARD", interval: "month", status: "CANCELED", cancelAtPeriodEnd: true, currentPeriodStart: new Date(Date.now() - 31 * DAY), currentPeriodEnd: new Date(Date.now() - DAY) },
    });
    const acc = await makeAccount(owner, { planBalance: 900, allowancePlan: "STANDARD", allowanceKey: `creem:paid:t84_${sfx}` });

    expect((await ensureCurrentGrant(acc.id)).action).toBe("plan_ended");
    expect(await balanceOf(acc.id)).toMatchObject({ planBalance: PLANS.FREE.credits, allowancePlan: "FREE", allowanceKey: await currentFreeKey(owner) });
    expect(await db.memberLimitGrace.findUnique({ where: { ownerId: owner } })).toMatchObject({ limit: 0 });
    expect((await ensureCurrentGrant(acc.id)).action).toBe("none");

    // Someone who already had this Free period's credits before subscribing restarts at 0.
    const again = await makeUser("ended_again");
    await db.subscription.create({ data: { userId: again, plan: "LITE", interval: "month", status: "EXPIRED" } });
    const acc2 = await makeAccount(again, { planBalance: 500, allowancePlan: "LITE", allowanceKey: `creem:paid:t84b_${sfx}` });
    await db.creditLedger.create({
      data: { accountId: acc2.id, type: "GRANT", planDelta: 100, topupDelta: 0, planAfter: 100, topupAfter: 0, reason: "free_monthly", idempotencyKey: `test84:${again}` },
    });
    await ensureCurrentGrant(acc2.id);
    expect(await balanceOf(acc2.id)).toMatchObject({ planBalance: 0, allowancePlan: "FREE" });
  });

  it("reserve() grants the current allowance before spending", async () => {
    const userId = await makeUser("reserve");
    const acc = await makeAccount(userId, { planBalance: 1, allowanceKey: `free:${userId}:2000-01-01` });
    const result = await reserve(acc.id, 10, `s84_res_${sfx}`, { generationId: `gen84_${sfx}` });
    expect(result.planBalance).toBe(PLANS.FREE.credits - 10);
  });

  it("an ended collaborator grace is enforced once: suspensions, one notification each", async () => {
    const owner = await makeUser("grace_owner");
    const member = await makeUser("grace_member");
    const ws = await db.workspace.create({ data: { ownerId: owner, title: "Grace" } });
    await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: member, role: "EDITOR", invitedById: owner } });
    await db.memberLimitGrace.create({ data: { ownerId: owner, limit: 0, graceEndsAt: new Date(Date.now() - DAY) } });
    const acc = await makeAccount(owner, { planBalance: 50, allowanceKey: await currentFreeKey(owner) });

    await Promise.all([ensureCurrentGrant(acc.id), ensureCurrentGrant(acc.id)]);
    await ensureCurrentGrant(acc.id);

    const row = await db.workspaceMember.findFirstOrThrow({ where: { workspaceId: ws.id, userId: member } });
    expect(row.suspendedAt).not.toBeNull();
    expect(await db.notification.count({ where: { userId: member, type: "MEMBER_SUSPENDED" } })).toBe(1);
    expect((await db.memberLimitGrace.findUniqueOrThrow({ where: { ownerId: owner } })).enforcedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------- refunds

describe("Step 8.4 — getRefundEligibility", () => {
  async function subscriber(label: string, payments: Array<{ at: Date; spent?: number }>, refunds = 0) {
    const userId = await makeUser(label);
    const s = await db.subscription.create({ data: { userId, plan: "STANDARD", interval: "month", status: "ACTIVE" } });
    const acc = await makeAccount(userId, { planBalance: 0 });
    let i = 0;
    for (const p of payments) {
      i++;
      await db.creditLedger.create({
        data: { accountId: acc.id, type: "GRANT", planDelta: 1000, topupDelta: 0, planAfter: 1000, topupAfter: 0, reason: "subscription.paid", idempotencyKey: `creem:paid:${label}_${sfx}_${i}`, createdAt: p.at },
      });
      if (p.spent) {
        await db.creditLedger.create({
          data: { accountId: acc.id, type: "RESERVE", planDelta: -p.spent, topupDelta: 0, planAfter: 1000 - p.spent, topupAfter: 0, idempotencyKey: `spend:${label}_${sfx}_${i}`, createdAt: new Date(p.at.getTime() + 1000) },
        });
      }
    }
    for (let r = 0; r < refunds; r++) {
      await db.creditLedger.create({
        data: { accountId: acc.id, type: "REFUND", planDelta: 0, topupDelta: 0, planAfter: 0, topupAfter: 0, reason: "refund.created:x", idempotencyKey: `creem:refund:${label}_${sfx}_${r}` },
      });
    }
    return s.id;
  }

  const paidAt = d("2026-11-01T00:00:00Z");
  const after = (days: number) => new Date(paidAt.getTime() + days * DAY);

  it("first purchase: within 14 days and < 20 % used", async () => {
    const id = await subscriber("fp_ok", [{ at: paidAt, spent: 150 }]);
    expect(await getRefundEligibility(id, after(13))).toMatchObject({ eligible: true, rule: "first_purchase_14d", creditsUsedPct: 15, paymentNumber: 1, daysSincePayment: 13 });
    expect(await getRefundEligibility(id, after(14))).toMatchObject({ eligible: false, rule: "first_purchase_14d" });
    const heavy = await subscriber("fp_heavy", [{ at: paidAt, spent: 200 }]);
    expect(await getRefundEligibility(heavy, after(1))).toMatchObject({ eligible: false, creditsUsedPct: 20 });
    const refundedBefore = await subscriber("fp_again", [{ at: paidAt }], 1);
    expect(await getRefundEligibility(refundedBefore, after(1))).toMatchObject({ eligible: false, previousRefunds: 1 });
  });

  it("renewal: within 7 days and no credits used since", async () => {
    const id = await subscriber("rn_ok", [{ at: d("2026-10-01T00:00:00Z"), spent: 900 }, { at: paidAt }]);
    expect(await getRefundEligibility(id, after(6))).toMatchObject({ eligible: true, rule: "renewal_7d", paymentNumber: 2, creditsUsedPct: 0 });
    expect(await getRefundEligibility(id, after(7))).toMatchObject({ eligible: false, rule: "renewal_7d" });
    const used = await subscriber("rn_used", [{ at: d("2026-10-01T00:00:00Z") }, { at: paidAt, spent: 1 }]);
    expect(await getRefundEligibility(used, after(1))).toMatchObject({ eligible: false, rule: "renewal_7d" });
  });

  it("a second payment within 24 h is a likely duplicate charge: always refunded", async () => {
    const id = await subscriber("dup", [{ at: paidAt }, { at: new Date(paidAt.getTime() + 60_000), spent: 500 }]);
    expect(await getRefundEligibility(id, after(20))).toMatchObject({ eligible: true, rule: "error" });
  });

  it("no payment: not eligible, no rule; unknown subscription → 404", async () => {
    const id = await subscriber("none", []);
    expect(await getRefundEligibility(id)).toMatchObject({ eligible: false, rule: null, paymentNumber: 0 });
    await expect(getRefundEligibility("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("a billing support request carries the refund check to the support inbox", async () => {
    await subscriber("ticket", [{ at: new Date(Date.now() - DAY), spent: 10 }]);
    const userId = `s84_ticket_${sfx}`;
    await createSupportTicket(
      { userId, role: "USER", sessionId: "sess", email: `${userId}@example.com` },
      { email: `${userId}@example.com`, topic: "billing", message: "Please refund my first payment." } as never
    );
    const call = mockSendEmail.mock.calls.find((c) => c[0] === "support-notification");
    expect(call?.[2]).toMatchObject({ refundEligibility: { eligible: true, rule: "first_purchase_14d", paymentNumber: 1 } });
  });
});

// ---------------------------------------------------------------- refund before payment

describe("Step 8.4 — a refund that arrives before its payment", () => {
  const SECRET = "whsec_test_8_4";
  const PRODUCTS: CreemProductIds = {
    LITE: { month: "prod_lite_m", year: "prod_lite_y" },
    STANDARD: { month: "prod_std_m", year: "prod_std_y" },
    PRO: { month: "prod_pro_m", year: "prod_pro_y" },
  };
  const cancels: string[] = [];
  const creem = createCreemProvider({ apiKey: "creem_test_x", apiBase: "https://test-api.creem.io", webhookSecret: SECRET, products: PRODUCTS }, jest.fn() as unknown as typeof fetch);
  const provider: BillingProvider = {
    ...creem,
    async cancelSubscription(id) {
      cancels.push(id);
    },
  };
  let seq = 0;
  const deliver = (eventType: string, object: Record<string, unknown>, at: number) => {
    const raw = JSON.stringify({ id: `evt84_${sfx}_${++seq}`, eventType, created_at: at, object });
    return handleBillingWebhook(raw, createHmac("sha256", SECRET).update(raw).digest("hex"), "req84");
  };
  const paidObject = (userId: string, subId: string, tx: string) => ({
    id: subId,
    product: { id: "prod_std_m" },
    customer: { id: `cust_${subId}` },
    status: "active",
    current_period_start_date: new Date().toISOString(),
    current_period_end_date: new Date(Date.now() + 30 * DAY).toISOString(),
    metadata: { userId },
    last_transaction: { id: tx, amount_paid: 2000 },
  });

  beforeAll(() => setBillingProviderForTests(provider));

  it("partial refund first: the late payment grants only the unrefunded share", async () => {
    const userId = await makeUser("early_partial");
    await makeAccount(userId, { planBalance: 0, allowanceKey: await currentFreeKey(userId) });
    await db.subscription.create({ data: { userId, plan: "STANDARD", interval: "month", status: "ACTIVE", providerSubscriptionId: `sub84_p_${sfx}` } });
    const t0 = Date.now();
    await deliver("refund.created", { id: `ref84_p_${sfx}`, refund_amount: 500, transaction: { id: `tx84_p_${sfx}`, amount_paid: 2000, refunded_amount: 500 }, subscription: `sub84_p_${sfx}` }, t0);
    await deliver("subscription.paid", paidObject(userId, `sub84_p_${sfx}`, `tx84_p_${sfx}`), t0 + 1000);

    const acc = await db.creditAccount.findUniqueOrThrow({ where: { userId } });
    expect(acc.planBalance).toBe(PLANS.STANDARD.credits - Math.floor(PLANS.STANDARD.credits / 4));
    expect(acc.allowancePlan).toBe("STANDARD");
  });

  it("full refund first: the late payment grants nothing and ends the plan", async () => {
    const userId = await makeUser("early_full");
    await makeAccount(userId, { planBalance: 0, allowanceKey: await currentFreeKey(userId) });
    await db.subscription.create({ data: { userId, plan: "STANDARD", interval: "month", status: "ACTIVE", providerSubscriptionId: `sub84_f_${sfx}` } });
    const t0 = Date.now();
    await deliver("refund.created", { id: `ref84_f_${sfx}`, refund_amount: 2000, transaction: { id: `tx84_f_${sfx}`, amount_paid: 2000, refunded_amount: 2000 }, subscription: `sub84_f_${sfx}` }, t0);
    cancels.length = 0;
    await deliver("subscription.paid", paidObject(userId, `sub84_f_${sfx}`, `tx84_f_${sfx}`), t0 + 1000);

    const acc = await db.creditAccount.findUniqueOrThrow({ where: { userId } });
    expect(acc.planBalance).toBe(0);
    expect(await db.creditLedger.count({ where: { accountId: acc.id, reason: "subscription.paid" } })).toBe(0);
    expect(await db.subscription.findUniqueOrThrow({ where: { userId } })).toMatchObject({ status: "CANCELED", cancelAtPeriodEnd: false });
    expect(cancels).toEqual([`sub84_f_${sfx}`]);
  });
});

// ---------------------------------------------------------------- disposable emails

describe("Step 8.4 — disposable email domains are refused at sign-up", () => {
  it("matches listed domains and their subdomains only", async () => {
    const { isDisposableEmail } = await import("@/server/auth/disposable-email");
    expect(isDisposableEmail("someone@mailinator.com")).toBe(true);
    expect(isDisposableEmail("Someone@Inbox.YOPMAIL.com")).toBe(true);
    expect(isDisposableEmail("someone@gmail.com")).toBe(false);
    expect(isDisposableEmail("someone@notmailinator.com")).toBe(false);
  });

  it("sign-up with a throwaway inbox fails with DISPOSABLE_EMAIL and creates no user", async () => {
    const { auth } = await import("@/server/auth/auth");
    const email = `s84_throwaway_${sfx}@mailinator.com`;
    const err = await auth.api
      .signUpEmail({ body: { email, password: "a-long-password-123", name: "Throwaway" } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ body: { code: "DISPOSABLE_EMAIL" } });
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });
});
