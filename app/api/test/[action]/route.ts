import { NextResponse } from "next/server";
import { z } from "zod";
import { route } from "@/server/http/route";
import { Errors } from "@/server/http/errors";
import { db } from "@/server/db/client";
import {
  completeFakeCheckout,
  isE2ETestMode,
  ledgerCheck,
  readTestEmails,
  sendFakeSubscriptionEvent,
  subscribeForTest,
} from "@/server/testing/e2e";

/**
 * Step 10.4: helpers for the end-to-end tests. **404 unless
 * `E2E_TEST_MODE=true`**, which `server/env.ts` refuses on any Vercel
 * deployment, so these never exist on dev.klecx.com or klecx.com.
 *
 * - `GET  /api/test/emails?to=` — the test inbox (newest last).
 * - `GET  /api/test/creem-checkout?checkout=` — the fake hosted checkout:
 *   "pays", sends the signed webhooks, redirects back like Creem.
 * - `POST /api/test/subscribe` `{ email, plan, interval? }` — a paid plan
 *   through the real checkout and webhook path, without a browser.
 * - `POST /api/test/subscription-event` `{ email, type }` — Creem reports a
 *   change (e.g. `subscription.past_due`).
 * - `GET  /api/test/ledger-check?email=` — the load test's check: balances
 *   equal the ledger sums and never went negative.
 */
const emailBody = z.object({ email: z.string().email() });
const setCreditsBody = z.object({ email: z.string().email(), balance: z.number().int().min(0).max(100_000) });

const subscribeBody = z.object({
  email: z.string().email(),
  plan: z.enum(["LITE", "STANDARD", "PRO"]),
  interval: z.enum(["month", "year"]).optional(),
});
const eventBody = z.object({
  email: z.string().email(),
  type: z.enum(["subscription.past_due", "subscription.active", "subscription.canceled", "subscription.expired", "subscription.paid"]),
});

function guard(action: string): void {
  if (!isE2ETestMode()) throw Errors.notFound("Route");
  void action;
}

export const GET = route({
  auth: "optional",
  handler: async ({ req, params }) => {
    const action = String(params.action ?? "");
    guard(action);
    if (action === "emails") {
      return { emails: readTestEmails(req.nextUrl.searchParams.get("to") ?? undefined) };
    }
    if (action === "ledger-check") {
      const out = await ledgerCheck(req.nextUrl.searchParams.get("email") ?? "");
      if (!out) throw Errors.notFound("Account");
      return out;
    }
    if (action === "creem-checkout") {
      const back = await completeFakeCheckout(req.nextUrl.searchParams.get("checkout") ?? "");
      if (!back) throw Errors.notFound("Checkout");
      return NextResponse.redirect(back, 303);
    }
    throw Errors.notFound("Route");
  },
});

export const POST = route({
  auth: "optional",
  handler: async ({ req, params }) => {
    const action = String(params.action ?? "");
    guard(action);
    const raw = await req.json().catch(() => ({}));
    if (action === "subscribe") {
      const body = subscribeBody.parse(raw);
      return subscribeForTest(body.email, body.plan, body.interval ?? "month");
    }
    if (action === "set-credits") {
      // Pre-10.6 fix: a low balance for the low-credits journey, through a
      // ledger adjustment (so ledger-check stays consistent).
      const body = setCreditsBody.parse(raw);
      const account = await db.creditAccount.findFirst({
        where: { user: { email: { equals: body.email, mode: "insensitive" } } },
        select: { id: true, planBalance: true, topupBalance: true },
      });
      if (!account) throw Errors.notFound("Account");
      const { adjust } = await import("@/server/services/credits");
      return adjust(
        account.id,
        { plan: body.balance - account.planBalance, topup: -account.topupBalance },
        "e2e.set_credits",
        `e2e:set-credits:${account.id}:${Date.now()}`
      );
    }
    if (action === "remove-password") {
      // Pre-10.6 fix: an account like one that signs in with Google only (no
      // password), for the "add a password" journey.
      const body = emailBody.parse(raw);
      const user = await db.user.findFirst({
        where: { email: { equals: body.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (!user) throw Errors.notFound("User");
      const removed = await db.account.deleteMany({ where: { userId: user.id, providerId: "credential" } });
      return { removed: removed.count };
    }
    if (action === "subscription-event") {
      const body = eventBody.parse(raw);
      const sub = await db.subscription.findFirst({
        where: { user: { email: { equals: body.email, mode: "insensitive" } } },
        select: { providerSubscriptionId: true },
      });
      if (!sub?.providerSubscriptionId) throw Errors.notFound("Subscription");
      const status = await sendFakeSubscriptionEvent(sub.providerSubscriptionId, body.type);
      return { webhookStatus: status };
    }
    throw Errors.notFound("Route");
  },
});
