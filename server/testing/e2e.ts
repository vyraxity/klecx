import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { env } from "@/server/env";

/**
 * Step 10.4 — test mode for the end-to-end and load tests (`E2E_TEST_MODE=true`).
 *
 * `server/env.ts` refuses it on any Vercel deployment, so it only ever runs on
 * a CI runner or a developer's machine. While it's on:
 * - **emails** are kept in an in-memory inbox instead of being sent
 *   (`GET /api/test/emails?to=` reads them);
 * - **Creem** is replaced by a fake network layer under the real Creem
 *   adapter (`fakeCreemFetch`): a checkout's URL is a local page
 *   (`/api/test/creem-checkout`) that sends the same **signed** webhooks Creem
 *   would (checkout.completed, subscription.paid) to the real webhook route,
 *   so the real signature check and state machine run;
 * - the fake AI and voice providers may run in a production build, and rate
 *   limits use the in-memory store (no Redis).
 *
 * State lives on `globalThis`: one `next start` process, shared by every route.
 */

export function isE2ETestMode(): boolean {
  return env.E2E_TEST_MODE === true;
}

// ---------------------------------------------------------------- inbox

export interface TestEmail {
  at: string;
  to: string;
  template: string;
  subject: string;
  text: string;
  /** Every http(s) link found in the text and HTML, in order. */
  links: string[];
}

type E2EState = {
  inbox: TestEmail[];
  checkouts: Map<string, FakeCheckout>;
  subscriptions: Map<string, FakeSubscription>;
};

type FakeCheckout = {
  id: string;
  requestId: string;
  productId: string;
  successUrl: string;
  customerId: string;
  metadata: Record<string, unknown>;
};

type FakeSubscription = {
  id: string;
  customerId: string;
  productId: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  canceledAt: Date | null;
  metadata: Record<string, unknown>;
};

function state(): E2EState {
  const g = globalThis as unknown as { __klecxE2E?: E2EState };
  g.__klecxE2E ??= { inbox: [], checkouts: new Map(), subscriptions: new Map() };
  return g.__klecxE2E;
}

const LINK_RE = /https?:\/\/[^\s"'<>)]+/g;

export function recordTestEmail(email: Omit<TestEmail, "at" | "links"> & { html?: string }): void {
  const links = [
    ...new Set(
      [...(email.text.match(LINK_RE) ?? []), ...((email.html ?? "").match(LINK_RE) ?? [])].map((l) => l.replace(/&amp;/g, "&"))
    ),
  ];
  const inbox = state().inbox;
  inbox.push({ at: new Date().toISOString(), to: email.to, template: email.template, subject: email.subject, text: email.text, links });
  if (inbox.length > 1000) inbox.splice(0, inbox.length - 1000);
}

export function readTestEmails(to?: string): TestEmail[] {
  const want = to?.toLowerCase();
  return state().inbox.filter((e) => !want || e.to.toLowerCase() === want);
}

// ---------------------------------------------------------------- fake Creem

const DAY = 24 * 60 * 60 * 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function subscriptionObject(sub: FakeSubscription, transactionId?: string, amount = 1000) {
  return {
    id: sub.id,
    object: "subscription",
    product: { id: sub.productId, object: "product" },
    customer: { id: sub.customerId, object: "customer" },
    status: sub.status,
    current_period_start_date: sub.periodStart.toISOString(),
    current_period_end_date: sub.periodEnd.toISOString(),
    canceled_at: sub.canceledAt?.toISOString() ?? null,
    metadata: sub.metadata,
    ...(transactionId
      ? { last_transaction: { id: transactionId, object: "transaction", amount, amount_paid: amount, status: "paid" } }
      : {}),
    mode: "test",
  };
}

/**
 * Stands in for `fetch` under the Creem adapter (`createCreemProvider`) in
 * test mode. Answers the calls Klecx makes, in Creem's shapes.
 */
export async function fakeCreemFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  const s = state();
  const appUrl = env.APP_URL.replace(/\/$/, "");

  if (url.pathname === "/v1/checkouts") {
    const id = `ch_e2e_${randomUUID()}`;
    const customer = (body.customer ?? {}) as { id?: string };
    s.checkouts.set(id, {
      id,
      requestId: String(body.request_id),
      productId: String(body.product_id),
      successUrl: String(body.success_url),
      customerId: customer.id ?? `cust_e2e_${randomUUID()}`,
      metadata: (body.metadata ?? {}) as Record<string, unknown>,
    });
    return json({ id, checkout_url: `${appUrl}/api/test/creem-checkout?checkout=${encodeURIComponent(id)}` });
  }
  if (url.pathname === "/v1/customers/billing") {
    return json({ customer_portal_link: `${appUrl}/settings/billing?portal=e2e` });
  }
  const action = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)\/(cancel|resume|upgrade)$/);
  if (action) {
    const sub = s.subscriptions.get(decodeURIComponent(action[1]!));
    if (!sub) return json({ message: "not found" }, 404);
    if (action[2] === "cancel") {
      if (body.mode === "immediate") {
        sub.status = "canceled";
        sub.canceledAt = new Date();
      } else {
        sub.status = "scheduled_cancel";
      }
    } else if (action[2] === "resume") {
      sub.status = "active";
      sub.canceledAt = null;
    } else {
      sub.productId = String(body.product_id);
    }
    return json(subscriptionObject(sub));
  }
  if (url.pathname === "/v1/subscriptions" && init?.method === "GET") {
    const sub = s.subscriptions.get(url.searchParams.get("subscription_id") ?? "");
    return sub ? json(subscriptionObject(sub)) : json({ message: "not found" }, 404);
  }
  return json({ message: `fake Creem: ${url.pathname} not handled` }, 404);
}

/** Sends one signed webhook to our own endpoint, exactly as Creem would. */
async function deliver(eventType: string, object: Record<string, unknown>): Promise<number> {
  const payload = JSON.stringify({ id: `evt_e2e_${randomUUID()}`, eventType, created_at: Date.now(), object });
  const signature = createHmac("sha256", env.CREEM_WEBHOOK_SECRET ?? "").update(payload).digest("hex");
  // Imported lazily: the webhook service pulls in the whole billing stack.
  const { handleBillingWebhook } = await import("@/server/services/billing-webhook");
  const res = await handleBillingWebhook(payload, signature, `e2e_${randomUUID()}`);
  return res.status;
}

/**
 * The fake hosted checkout: "pays", sends checkout.completed then
 * subscription.paid, and returns where Creem would send the buyer back.
 */
export async function completeFakeCheckout(checkoutId: string): Promise<string | null> {
  const s = state();
  const checkout = s.checkouts.get(checkoutId);
  if (!checkout) return null;
  s.checkouts.delete(checkoutId);
  const now = new Date();
  const sub: FakeSubscription = {
    id: `sub_e2e_${randomUUID()}`,
    customerId: checkout.customerId,
    productId: checkout.productId,
    status: "active",
    periodStart: now,
    periodEnd: new Date(now.getTime() + 30 * DAY),
    canceledAt: null,
    metadata: checkout.metadata,
  };
  s.subscriptions.set(sub.id, sub);
  await deliver("checkout.completed", {
    id: checkout.id,
    object: "checkout",
    request_id: checkout.requestId,
    customer: { id: checkout.customerId },
    subscription: subscriptionObject(sub),
    metadata: checkout.metadata,
  });
  await deliver("subscription.paid", subscriptionObject(sub, `tran_e2e_${randomUUID()}`));
  const back = new URL(checkout.successUrl, env.APP_URL);
  back.searchParams.set("checkout_id", checkout.id);
  return back.toString();
}

/**
 * Tests: make Creem report a change on a subscription (e.g. `past_due` for
 * the payment-issue banner), as the matching webhook.
 */
export async function sendFakeSubscriptionEvent(
  subscriptionId: string,
  eventType: "subscription.past_due" | "subscription.active" | "subscription.canceled" | "subscription.expired" | "subscription.paid"
): Promise<number | null> {
  const sub = state().subscriptions.get(subscriptionId);
  if (!sub) return null;
  const status = eventType.split(".")[1]!;
  if (status !== "paid") sub.status = status === "canceled" ? "canceled" : status;
  return deliver(eventType, subscriptionObject(sub, eventType === "subscription.paid" ? `tran_e2e_${randomUUID()}` : undefined));
}

export function listFakeSubscriptions(): Array<{ id: string; status: string; metadata: Record<string, unknown> }> {
  return [...state().subscriptions.values()].map((s) => ({ id: s.id, status: s.status, metadata: s.metadata }));
}

/**
 * Tests: put a person on a paid plan through the real checkout path
 * (`startCheckout` → fake Creem → signed webhooks), without a browser.
 */
export async function subscribeForTest(
  email: string,
  plan: "LITE" | "STANDARD" | "PRO",
  interval: "month" | "year" = "month"
): Promise<{ subscriptionId: string | null }> {
  const { db } = await import("@/server/db/client");
  const { startCheckout } = await import("@/server/services/billing");
  const user = await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
  if (!user) throw new Error("No such user");
  const { url } = await startCheckout(user.id, { plan, interval, consentImmediateStart: true }, `e2e_${randomUUID()}`);
  const checkoutId = new URL(url).searchParams.get("checkout") ?? "";
  await completeFakeCheckout(checkoutId);
  const sub = await db.subscription.findUnique({ where: { userId: user.id }, select: { providerSubscriptionId: true } });
  return { subscriptionId: sub?.providerSubscriptionId ?? null };
}

/**
 * Load test (Step 10.4): does the person's credit account still add up?
 * Balances must equal the sums of their ledger rows and never have gone
 * below zero.
 */
export async function ledgerCheck(email: string) {
  const { db } = await import("@/server/db/client");
  const account = await db.creditAccount.findFirst({
    where: { user: { email: { equals: email, mode: "insensitive" } } },
    select: { id: true, planBalance: true, topupBalance: true },
  });
  if (!account) return null;
  const sums = await db.creditLedger.aggregate({
    where: { accountId: account.id },
    _sum: { planDelta: true, topupDelta: true },
    _min: { planAfter: true, topupAfter: true },
    _count: { _all: true },
  });
  const planSum = sums._sum.planDelta ?? 0;
  const topupSum = sums._sum.topupDelta ?? 0;
  return {
    planBalance: account.planBalance,
    topupBalance: account.topupBalance,
    ledgerPlanSum: planSum,
    ledgerTopupSum: topupSum,
    ledgerRows: sums._count._all,
    lowestPlanAfter: sums._min.planAfter ?? 0,
    lowestTopupAfter: sums._min.topupAfter ?? 0,
    consistent: planSum === account.planBalance && topupSum === account.topupBalance,
    neverNegative: account.planBalance >= 0 && account.topupBalance >= 0 && (sums._min.planAfter ?? 0) >= 0 && (sums._min.topupAfter ?? 0) >= 0,
  };
}
