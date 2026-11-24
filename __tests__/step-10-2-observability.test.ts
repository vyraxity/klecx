/**
 * @jest-environment node
 *
 * Step 10.2 — logs, Sentry scrubbing, provider cost, business metrics (checked
 * against a hand calculation on seeded data) and alerts (a drill on seeded data).
 * The seeded rows are dated in March 2001 so other tests' data never falls in range.
 */
import { Writable } from "node:stream";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/server/db/client";
import { createLogger, errInfo, maskEmailForLog } from "@/server/log";
import { scrubEvent, sharedSentryOptions, stripQuery, SENTRY_TUNNEL_ROUTE } from "@/lib/monitoring/sentry-options";
import { generationCostUsd, PROVIDER_SEARCH_USD } from "@/server/monitoring/costs";
import { computeMetrics, getBusinessMetrics, percentile } from "@/server/services/metrics";
import { evaluateAlerts, runAlertChecks, listAlerts } from "@/server/monitoring/alerts";
import { recordLimitHit } from "@/server/monitoring/limit-hits";
import { route, routePattern } from "@/server/http/route";
import { ApiError } from "@/server/http/errors";
import type { Actor } from "@/server/auth/session";

const mockCapture = jest.fn();
jest.mock("../server/monitoring/sentry", () => ({ captureServerError: (...a: unknown[]) => mockCapture(...a) }));

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => ({ getActor: jest.fn(async () => mockActor) }));

const sent: { template: string; to: string; data: Record<string, unknown> }[] = [];
jest.mock("../server/email/send", () => {
  const actual = jest.requireActual("../server/email/send");
  return {
    ...actual,
    sendEmail: jest.fn(async (template: string, to: string, data: Record<string, unknown>) => {
      sent.push({ template, to, data });
      return { success: true, id: "mock" };
    }),
  };
});

const sfx = `${Date.now()}`.slice(-7);
const FREE = { id: `obs_free_${sfx}`, acc: `obs_acc_free_${sfx}` };
const PRO = { id: `obs_pro_${sfx}`, acc: `obs_acc_pro_${sfx}` };
const WS = crypto.randomUUID();
const D = (s: string) => new Date(`2001-03-${s}Z`);
const FROM = D("01T00:00:00");
const TO = D("08T00:00:00");

function gen(over: Record<string, unknown>) {
  return {
    actorId: FREE.id,
    billedAccountId: FREE.acc,
    kind: "TEXT",
    status: "COMPLETED",
    modelKey: "text-economy",
    providerModelId: "x",
    promptVersion: "1",
    idempotencyKey: `obs_${sfx}_${crypto.randomUUID()}`,
    ...over,
  } as never;
}

function paidEvent(id: string, userId: string, transaction: string, amount: number, at: Date) {
  return {
    provider: "creem",
    providerEventId: `evt_${sfx}_${id}`,
    type: "subscription.paid",
    status: "PROCESSED",
    userId,
    receivedAt: at,
    payload: { object: { id: `sub_${sfx}`, status: "active", last_transaction: { id: transaction, amount_paid: amount } } },
  };
}

async function cleanup() {
  const ids = [FREE.id, PRO.id];
  await db.generation.deleteMany({ where: { actorId: { in: ids } } });
  await db.billingEvent.deleteMany({ where: { providerEventId: { startsWith: `evt_${sfx}_` } } });
  await db.usageLimitHit.deleteMany({ where: { userId: { in: ids } } });
  await db.monitoringAlert.deleteMany({ where: { OR: [{ key: { contains: sfx } }, { summary: { in: ["providerErrors", "providerAuth", "webhookFailures", "stuckGenerations"] } }] } });
  await db.workspace.deleteMany({ where: { id: WS } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await cleanup();
  await db.user.create({ data: { id: FREE.id, email: `${FREE.id}@example.com`, name: "Free", emailVerified: true, createdAt: D("02T10:00:00") } });
  await db.user.create({ data: { id: PRO.id, email: `${PRO.id}@example.com`, name: "Pro", emailVerified: false, createdAt: D("03T10:00:00") } });
  await db.creditAccount.create({ data: { id: FREE.acc, userId: FREE.id, allowancePlan: "FREE" } });
  await db.creditAccount.create({ data: { id: PRO.acc, userId: PRO.id, allowancePlan: "PRO" } });
  await db.workspace.create({ data: { id: WS, ownerId: FREE.id, title: "Obs" } });

  await db.generation.createMany({
    data: [
      // Free: a completed answer with 2 searches, 1M in / 100k out tokens.
      // cost = (1,000,000 × 0.25 + 100,000 × 1.5) / 1e6 + 2 × PROVIDER_SEARCH_USD = 0.25 + 0.15 + 0.028 = 0.428
      gen({ createdAt: D("02T12:00:00"), startedAt: D("02T12:00:00"), firstTokenAt: D("02T12:00:01"), finishedAt: D("02T12:00:05"), usage: { inputTokens: 1_000_000, outputTokens: 100_000, thoughtTokens: 0, searches: 2 } }),
      // Free: a failed answer (provider unavailable), no usage → cost 0.
      gen({ createdAt: D("02T13:00:00"), status: "FAILED", errorCode: "unavailable" }),
      // Pro: a standard answer, 200k in, 20k out + 10k thought → (200,000 × 1.5 + 30,000 × 7.5) / 1e6 = 0.3 + 0.225 = 0.525
      gen({ actorId: PRO.id, billedAccountId: PRO.acc, modelKey: "text-standard", createdAt: D("03T12:00:00"), startedAt: D("03T12:00:00"), firstTokenAt: D("03T12:00:03"), finishedAt: D("03T12:00:09"), usage: { inputTokens: 200_000, outputTokens: 20_000, thoughtTokens: 10_000 } }),
      // Pro: read-aloud, 100 s and 1,500 chars at 2001 prices → 100 × 0.00015 + ceil(1500/4)=375 × 0.5 / 1e6 = 0.015 + 0.0001875
      gen({ actorId: PRO.id, billedAccountId: PRO.acc, kind: "SPEECH", modelKey: "speech", createdAt: D("03T14:00:00"), usage: { seconds: 100, chars: 1500 } }),
      // Pro: a transcription of 30 s, 2,000 in / 100 out tokens → (2000 × 0.25 + 100 × 1.5) / 1e6 = 0.00065
      gen({ actorId: PRO.id, billedAccountId: PRO.acc, kind: "TRANSCRIPTION", modelKey: "audio-transcribe", createdAt: D("03T15:00:00"), usage: { inputTokens: 2000, outputTokens: 100, seconds: 30 } }),
      // Free: two Ask answers in the workspace.
      gen({ kind: "ANNOTATION_REPLY", workspaceId: WS, createdAt: D("04T09:00:00"), usage: { inputTokens: 0, outputTokens: 0 } }),
      gen({ kind: "QUESTION_BATCH", workspaceId: WS, createdAt: D("04T09:30:00"), usage: { inputTokens: 0, outputTokens: 0 } }),
      // Outside the range: ignored.
      gen({ createdAt: D("09T00:00:00"), usage: { inputTokens: 9_000_000, outputTokens: 0 } }),
    ],
  });

  await db.billingEvent.createMany({
    data: [
      paidEvent("p1", PRO.id, "tx_first", 2900, D("03T11:00:00")), // first purchase, $29
      paidEvent("p2", PRO.id, "tx_second", 2900, D("05T11:00:00")), // renewal, $29
      {
        provider: "creem", providerEventId: `evt_${sfx}_r1`, type: "refund.created", status: "PROCESSED", userId: PRO.id, receivedAt: D("06T09:00:00"),
        payload: { object: { id: `ref_${sfx}`, refund_amount: 2900, transaction: { id: "tx_first", amount_paid: 2900 } } },
      },
      { provider: "creem", providerEventId: `evt_${sfx}_d1`, type: "dispute.created", status: "PROCESSED", userId: PRO.id, receivedAt: D("06T10:00:00"), payload: { object: { id: `dis_${sfx}` } } },
      { provider: "creem", providerEventId: `evt_${sfx}_f1`, type: "subscription.update", status: "FAILED", userId: PRO.id, receivedAt: D("06T11:00:00"), payload: {} },
    ] as never,
  });

  for (const d of ["02", "03", "05"]) await recordLimitHit(FREE.id, "SEARCH_CAP", D(`${d}T08:00:00`));
  await recordLimitHit(FREE.id, "SEARCH_CAP", D("05T09:00:00")); // same day: counted, not a new day
}, 60_000);

afterAll(cleanup);
beforeEach(() => {
  sent.length = 0;
  mockCapture.mockReset();
});

describe("logs", () => {
  function capture() {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    return { logger: createLogger(stream, "info"), lines };
  }

  test("secrets, content and emails never reach a log line", () => {
    const { logger, lines } = capture();
    logger.info(
      {
        requestId: "req-1",
        email: "ada@example.com",
        user: { password: "hunter2", email: "bob@example.com" },
        headers: { cookie: "session=abc", authorization: "Bearer tok", "set-cookie": "x=y" },
        prompt: "my secret prompt",
        body: { content: "file contents", text: "more" },
        err: new Error("boom"),
      },
      "event"
    );
    const out = JSON.stringify(lines[0]);
    for (const leaked of ["hunter2", "session=abc", "Bearer tok", "x=y", "my secret prompt", "file contents", "ada@example.com", "bob@example.com"]) {
      expect([leaked, out.includes(leaked)]).toEqual([leaked, false]);
    }
    expect(lines[0]).toMatchObject({ level: "info", requestId: "req-1", email: "a***@example.com", msg: "event", err: { name: "Error", message: "boom" } });
  });

  test("errors are reduced to name, code and a short message", () => {
    const e = Object.assign(new Error("x".repeat(1000)), { code: "P2002", meta: { target: "secret" } });
    expect(errInfo(e)).toEqual({ name: "Error", code: "P2002", message: "x".repeat(300) });
    expect(errInfo("a string")).toEqual({ name: "string_error" });
    // Idempotent: `err: errInfo(e)` goes through pino's `err` serializer again.
    expect(errInfo(errInfo(e))).toEqual({ name: "Error", code: "P2002", message: "x".repeat(300) });
    expect(maskEmailForLog("not-an-email")).toBe("[redacted]");
  });

  test("route() logs the route pattern, never ids or query strings", () => {
    expect(routePattern("/api/v1/workspaces/0196f0c7-7c2a-7000-8000-000000000001/members/u_12")).toBe("/api/v1/workspaces/:id/members/:id");
    expect(routePattern("/api/v1/documents/abc/revisions/3")).toBe("/api/v1/documents/abc/revisions/:id");
    expect(routePattern("/api/v1/me/usage/summary")).toBe("/api/v1/me/usage/summary");
  });

  test("an unexpected error is sent to Sentry with the request id the client sees", async () => {
    mockActor = { userId: "u_obs", role: "USER", sessionId: "s", email: "u@example.com" } as Actor;
    const GET = route({ query: z.object({}).optional(), handler: async () => { throw new Error("db down"); } });
    const res = await GET(new NextRequest("http://localhost:3000/api/v1/x", { headers: { "x-request-id": "req-42" } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ code: "internal_error", requestId: "req-42" });
    expect(mockCapture).toHaveBeenCalledWith(expect.any(Error), { requestId: "req-42", userId: "u_obs", route: "/api/v1/x" });

    mockCapture.mockReset();
    const known = route({ handler: async () => { throw new ApiError(409, "conflict", "x"); } });
    expect((await known(new NextRequest("http://localhost:3000/api/v1/y"))).status).toBe(409);
    expect(mockCapture).not.toHaveBeenCalled(); // expected errors aren't Sentry events
  });
});

describe("Sentry", () => {
  test("off until the DSN is set, then on with no personal data", () => {
    const prev = process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(sharedSentryOptions()).toMatchObject({ enabled: false, sendDefaultPii: false, tracesSampleRate: 0 });
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@o1.ingest.sentry.io/1";
    expect(sharedSentryOptions()).toMatchObject({ enabled: true, dsn: "https://public@o1.ingest.sentry.io/1" });
    if (prev === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = prev;
    expect(SENTRY_TUNNEL_ROUTE).toBe("/sentry-tunnel");
  });

  test("events lose bodies, cookies, headers, query strings and every user field but the id", () => {
    const event = scrubEvent({
      request: {
        url: "https://klecx.com/account/restore?token=abc",
        data: { password: "x" },
        cookies: { session: "y" },
        headers: { cookie: "s=1", authorization: "Bearer z", "user-agent": "Firefox" },
        query_string: "token=abc",
      },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
      breadcrumbs: [
        { category: "console", message: "something" },
        { category: "fetch", data: { url: "/api/v1/x?token=abc", body: "secret" } },
      ],
    });
    expect(event).toEqual({
      request: { url: "https://klecx.com/account/restore", headers: { "user-agent": "Firefox" } },
      user: { id: "u1" },
      breadcrumbs: [{ category: "fetch", data: { url: "/api/v1/x" } }],
    });
    expect(stripQuery("/a#frag")).toBe("/a");
  });
});

describe("provider cost and business metrics (hand calculation)", () => {
  test("cost of each kind of call", () => {
    const at = D("02T00:00:00");
    expect(generationCostUsd({ kind: "TEXT", modelKey: "text-economy", status: "COMPLETED", usage: { inputTokens: 1_000_000, outputTokens: 100_000, searches: 2 }, createdAt: at })).toBeCloseTo(0.4 + 2 * PROVIDER_SEARCH_USD, 10);
    expect(generationCostUsd({ kind: "IMAGE", modelKey: "image-standard", status: "COMPLETED", usage: {}, createdAt: at })).toBeCloseTo(0.067, 10);
    expect(generationCostUsd({ kind: "IMAGE", modelKey: "image-standard", status: "FAILED", usage: {}, createdAt: at })).toBe(0);
    expect(generationCostUsd({ kind: "SPEECH", modelKey: "x", status: "COMPLETED", usage: { seconds: 100, chars: 1500 }, createdAt: at })).toBeCloseTo(0.0151875, 10);
    expect(percentile([5, 1, 9, 3], 50)).toBe(3);
    expect(percentile([], 95)).toBeNull();
  });

  test("the metrics equal the hand calculation", async () => {
    const m = await computeMetrics(FROM, TO);
    const free = 0.25 + 0.15 + 2 * PROVIDER_SEARCH_USD; // 0.428
    const pro = 0.525 + 0.0151875 + 0.00065;

    expect(m.generations).toMatchObject({ total: 7, completed: 6, failed: 1, failuresByCategory: { unavailable: 1 } });
    expect(m.generations.successRate).toBeCloseTo(6 / 7, 4);
    expect(m.cost.providerUsd).toBeCloseTo(free + pro, 4);
    expect(m.plans.FREE!.providerUsd).toBeCloseTo(free, 4);
    expect(m.plans.PRO!.providerUsd).toBeCloseTo(pro, 4);
    expect(m.plans.PRO!.revenueUsd).toBe(58);
    expect(m.cost.revenueUsd).toBe(58);
    expect(m.cost.costToRevenue).toBeCloseTo((free + pro) / 58, 4);

    expect(m.latencyMs["text-economy"]).toEqual({ count: 1, firstTokenP50: 1000, firstTokenP95: 1000, totalP50: 5000, totalP95: 5000 });
    expect(m.latencyMs["text-standard"]).toMatchObject({ firstTokenP50: 3000, totalP50: 9000 });

    expect(m.searches).toMatchObject({ executed: 2, byDay: { "2001-03-02": 2 } });
    expect(m.searches.providerUsd).toBeCloseTo(2 * PROVIDER_SEARCH_USD, 6);
    expect(m.searches.surchargeUsd).toBeCloseTo(2 * 3 * 0.002, 6);
    expect(m.voice).toMatchObject({ transcriptionSeconds: 30, readAloudSeconds: 100 });
    expect(m.asks).toMatchObject({ generations: 2, workspaces: 1, perWorkspaceMax: 2 });

    expect(m.billing).toMatchObject({ payments: 2, payers: 1, revenueUsd: 58, webhooks: { failed: 1 } });
    expect(m.billing.refunds).toMatchObject({ count: 1, amountUsd: 29, firstPurchase: 1, renewal: 0, rate: 0.5 });
    expect(m.billing.disputes).toEqual({ count: 1, rate: 0.5 });
    expect(m.funnel).toEqual({ signups: 2, verified: 1, firstGeneration: 2, paid: 1 });
    expect(m.limitHits.SEARCH_CAP).toEqual({ people: 1, hits: 4 });

    expect(m.daily).toHaveLength(7);
    expect(m.daily.find((d) => d.day === "2001-03-02")).toMatchObject({ total: 2, completed: 1, failed: 1 });
    expect(m.daily.find((d) => d.day === "2001-03-02")!.providerUsd).toBeCloseTo(free, 4);
  });

  test("admins only, and at most 92 days", async () => {
    const user = { userId: "u", role: "USER", sessionId: "s", email: "u@e.c" } as Actor;
    const admin = { ...user, role: "ADMIN" } as Actor;
    await expect(getBusinessMetrics(user, { from: FROM, to: TO })).rejects.toMatchObject({ status: 403 });
    await expect(getBusinessMetrics(admin, { from: TO, to: FROM })).rejects.toMatchObject({ code: "invalid_range" });
    await expect(getBusinessMetrics(admin, { from: D("01T00:00:00"), to: new Date("2001-07-01Z") })).rejects.toMatchObject({ code: "range_too_long" });
  });
});

describe("alerts (drill on seeded data)", () => {
  const NOW = D("20T12:00:00");

  beforeAll(async () => {
    const hourAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    await db.generation.createMany({
      data: [
        // 10 answers in the last hour: 4 provider failures (1 auth, 3 rate-limit) → 40 %.
        ...Array.from({ length: 6 }, (_, i) => gen({ createdAt: hourAgo(5 + i) })),
        gen({ createdAt: hourAgo(20), status: "FAILED", errorCode: "auth" }),
        ...Array.from({ length: 3 }, (_, i) => gen({ createdAt: hourAgo(30 + i), status: "FAILED", errorCode: "rate_limit" })),
        // A Free account spending $3 in the day (12M input tokens of text-economy).
        gen({ createdAt: hourAgo(120), kind: "TITLE", usage: { inputTokens: 12_000_000, outputTokens: 0 } }),
        // Stuck for an hour.
        gen({ createdAt: hourAgo(60), status: "RUNNING", startedAt: hourAgo(60) }),
      ],
    });
    await db.billingEvent.create({
      data: { provider: "creem", providerEventId: `evt_${sfx}_x1`, type: "subscription.update", status: "FAILED", userId: PRO.id, receivedAt: hourAgo(90), payload: {} },
    });
    for (const d of ["15", "17", "19"]) await recordLimitHit(PRO.id, "VOICE_CAP", D(`${d}T08:00:00`));
  });

  test("every condition is detected", async () => {
    const alerts = await evaluateAlerts(NOW);
    const byKey = Object.fromEntries(alerts.map((a) => [a.key, a]));
    expect(byKey.provider_errors).toMatchObject({ severity: "critical", values: { failed: 4, total: 10, rate: 40 } });
    expect(byKey.provider_auth?.values).toEqual({ count: 1 });
    expect(byKey.provider_quota?.values).toEqual({ count: 3 });
    expect(byKey.webhook_failures?.values).toMatchObject({ failed: 1 });
    expect(byKey[`account_cost:${FREE.id}`]?.values).toMatchObject({ plan: "FREE", limit: 2 });
    expect(Number(byKey[`account_cost:${FREE.id}`]?.values.usd)).toBeCloseTo(3, 2); // 12M × $0.25 / 1M
    expect(byKey[`limit_abuse:${PRO.id}:VOICE_CAP`]?.values).toMatchObject({ days: 3 });
    expect(byKey.stuck_generations?.values).toEqual({ count: 1 });
    expect(byKey[`limit_abuse:${FREE.id}:SEARCH_CAP`]).toBeUndefined(); // three weeks earlier
  });

  test("emailed once, translated, then quiet until the quiet period ends", async () => {
    const first = await runAlertChecks(NOW);
    expect(first.emailed).toEqual(expect.arrayContaining(["provider_errors", "provider_auth", `account_cost:${FREE.id}`]));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe("monitoring-alert");
    const { renderEmail } = jest.requireActual("../server/email/send");
    const email = await renderEmail("monitoring-alert", "ops@example.com", sent[0]!.data, { locale: "en" });
    expect(email.subject).toMatch(/^Klecx: \d+ alerts \(\d+ critical\)$/);
    expect(email.text).toContain("4 of 10 AI requests failed in the last hour (40 %)");
    expect(email.text).not.toMatch(/@example\.com.*cost/);

    sent.length = 0;
    const again = await runAlertChecks(new Date(NOW.getTime() + 10 * 60_000));
    expect(again.firing.map((a) => a.key)).toContain("provider_errors"); // still firing, but quiet
    expect(again.emailed).toEqual([]);
    expect(sent).toHaveLength(0);

    // An hour later the provider errors have left the one-hour window; the failed
    // webhook (24 h window, critical) is emailed again; the cost warning waits 6 h.
    const later = await runAlertChecks(new Date(NOW.getTime() + 61 * 60_000));
    expect(later.firing.map((a) => a.key)).not.toContain("provider_errors");
    expect(later.emailed).toEqual(["webhook_failures"]);

    const history = await listAlerts(200);
    expect(history.find((a) => a.key === "webhook_failures")).toMatchObject({ severity: "critical", occurrences: 3 });
    expect(history.find((a) => a.key === "provider_errors")).toMatchObject({ occurrences: 2 });
  });
});

describe("limit hits", () => {
  test("one row per person, kind and day; repeats are counted", async () => {
    const rows = await db.usageLimitHit.findMany({ where: { userId: FREE.id, kind: "SEARCH_CAP" }, orderBy: { day: "asc" } });
    expect(rows.map((r) => [r.day.toISOString().slice(0, 10), r.count])).toEqual([
      ["2001-03-02", 1],
      ["2001-03-03", 1],
      ["2001-03-05", 2],
    ]);
  });

  test("recorded where the limits are enforced", async () => {
    const fs = await import("fs");
    const where: [string, string][] = [
      ["server/services/billing-owner.ts", "DAILY_CREDIT_CAP"],
      ["server/services/billing-owner.ts", "CONCURRENCY"],
      ["server/services/web-search.ts", "SEARCH_CAP"],
      ["server/services/transcription.ts", "VOICE_CAP"],
      ["server/services/speech.ts", "READ_ALOUD_CAP"],
    ];
    for (const [file, kind] of where) expect([file, fs.readFileSync(file, "utf8").includes(`"${kind}"`)]).toEqual([file, true]);
  });
});
