/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { createAccountWithFreeGrant, grantPlanInTx, release, reserve, settle } from "@/server/services/credits";
import {
  getUsageByMember,
  getUsageSummary,
  getUsageTimeseries,
  listCreditHistory,
  breakdown,
} from "@/server/services/usage";
import { creditHistoryCsv, csvCell } from "@/server/services/usage-csv";
import { GET as summaryRoute } from "@/app/api/v1/me/usage/summary/route";
import { GET as timeseriesRoute } from "@/app/api/v1/me/usage/timeseries/route";
import { GET as byMemberRoute } from "@/app/api/v1/me/usage/by-member/route";
import { GET as historyRoute } from "@/app/api/v1/me/credits/history/route";
import type { Actor } from "@/server/auth/session";

// Deterministic periods: the lazy monthly grant is covered by Step 8.4's tests.
jest.mock("../server/billing/grants", () => {
  const actual = jest.requireActual("../server/billing/grants");
  return { ...actual, ensureCurrentGrantForUser: jest.fn(async () => ({ action: "none", resetsAt: null })) };
});

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => {
  const actual = jest.requireActual("../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});

const sfx = `${Date.now()}`.slice(-7);
const A = { id: `u93_a_${sfx}`, email: `u93_a_${sfx}@example.com`, name: "Ada Owner" };
const B = { id: `u93_b_${sfx}`, email: `u93_b_${sfx}@example.com`, name: "Bea Member" };
const C = { id: `u93_c_${sfx}`, email: `u93_c_${sfx}@example.com`, name: "Cy Other" };
const W1 = `w93_1_${sfx}`;
const W2 = `w93_2_${sfx}`;
let accountId = "";

const asActor = (u: { id: string; email: string }): Actor =>
  ({ userId: u.id, email: u.email, role: "USER", sessionId: `s_${u.id}` }) as Actor;
const req = (path: string) => new NextRequest(`http://localhost:3000${path}`);

async function spend(opts: {
  id: string;
  actorId: string;
  kind: "TEXT" | "ANNOTATION_REPLY" | "TRANSCRIPTION" | "DOCUMENT_REVIEW";
  modelKey: string;
  workspaceId: string | null;
  reserved: number;
  settled: number | "release";
  usage?: Record<string, number>;
}) {
  await db.generation.create({
    data: {
      id: opts.id,
      workspaceId: opts.workspaceId,
      actorId: opts.actorId,
      billedAccountId: accountId,
      kind: opts.kind,
      status: "COMPLETED",
      modelKey: opts.modelKey,
      providerModelId: "test-model",
      promptVersion: "test",
      idempotencyKey: `idem_${opts.id}`,
      usage: opts.usage ?? {},
    },
  });
  await reserve(accountId, opts.reserved, `res_${opts.id}`, { generationId: opts.id, actorId: opts.actorId });
  if (opts.settled === "release") await release(accountId, opts.id, `rel_${opts.id}`);
  else await settle(accountId, opts.id, opts.settled, `set_${opts.id}`);
}

async function ledgerSpendSum(account: string): Promise<number> {
  const rows = await db.$queryRaw<{ total: bigint | number }[]>`
    SELECT COALESCE(SUM(-(plan_delta + topup_delta)), 0) AS total
    FROM credit_ledger WHERE account_id = ${account} AND type::text IN ('RESERVE','SETTLE','RELEASE')`;
  return Number(rows[0]?.total ?? 0);
}

async function cleanup() {
  const ids = [A.id, B.id, C.id];
  await db.generation.deleteMany({ where: { actorId: { in: ids } } });
  await db.workspaceMember.deleteMany({ where: { workspaceId: { in: [W1, W2] } } });
  await db.workspace.deleteMany({ where: { id: { in: [W1, W2] } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await cleanup();
  for (const u of [A, B, C]) {
    await db.user.create({ data: { id: u.id, email: u.email, name: u.name, emailVerified: true } });
    await createAccountWithFreeGrant(u.id); // 100 credits, reason monthly_free
  }
  accountId = (await db.creditAccount.findUniqueOrThrow({ where: { userId: A.id } })).id;
  await db.workspace.create({ data: { id: W1, ownerId: A.id, title: "=HYPERLINK(\"x\") Marketing plan" } });
  await db.workspace.create({ data: { id: W2, ownerId: A.id, title: "Old workspace", deletedAt: new Date() } });

  // A: an answer with one web search (8 = 5 + 3 for the search).
  await spend({ id: `g1_${sfx}`, actorId: A.id, kind: "TEXT", modelKey: "text-economy", workspaceId: W1, reserved: 10, settled: 8, usage: { searches: 1 } });
  // B (collaborator, billed to A): an Ask.
  await spend({ id: `g2_${sfx}`, actorId: B.id, kind: "ANNOTATION_REPLY", modelKey: "text-economy", workspaceId: W1, reserved: 5, settled: 5 });
  // A: 30 s of transcription.
  await spend({ id: `g3_${sfx}`, actorId: A.id, kind: "TRANSCRIPTION", modelKey: "audio-transcribe", workspaceId: W1, reserved: 4, settled: 2, usage: { seconds: 30 } });
  // A: a failed answer, released in full (costs nothing).
  await spend({ id: `g4_${sfx}`, actorId: A.id, kind: "TEXT", modelKey: "text-standard", workspaceId: W1, reserved: 6, settled: "release" });
  // A: a review in a workspace that was deleted since.
  await spend({ id: `g5_${sfx}`, actorId: A.id, kind: "DOCUMENT_REVIEW", modelKey: "text-standard", workspaceId: W2, reserved: 7, settled: 7 });
});

afterAll(cleanup);
beforeEach(() => {
  mockActor = null;
});

describe("Step 9.3 — usage numbers equal the ledger", () => {
  it("summary: used = ledger sum; breakdowns add up; remaining = balance", async () => {
    const s = await getUsageSummary(A.id);
    expect(s.used).toBe(22);
    expect(s.used).toBe(await ledgerSpendSum(accountId));
    expect(s.remaining).toBe(78);
    expect(s.allowance).toBe(100);
    expect(s.byKind).toMatchObject({ text: 5, asks: 5, transcription: 2, reviews: 7, images: 0 });
    expect(s.webSearch).toEqual({ credits: 3, searches: 1 });
    expect(s.transcriptionSeconds).toBe(30);
    const kindsTotal = Object.values(s.byKind).reduce((a, b) => a + b, 0) + s.webSearch.credits;
    expect(kindsTotal).toBe(s.used);
    expect(s.byModel.reduce((a, b) => a + b.credits, 0)).toBe(s.used);
    expect(s.generations).toBe(4);
    expect(s.dailyCap.used).toBe(22);
    expect(s.dailyCap.cap).toBeGreaterThan(0);
  });

  it("timeseries: today's point equals the ledger, other days are zero", async () => {
    const today = new Date();
    const from = new Date(today.getTime() - 6 * 86_400_000);
    const points = await getUsageTimeseries(A.id, from, today);
    expect(points).toHaveLength(7);
    expect(points.reduce((a, p) => a + p.credits, 0)).toBe(22);
    expect(points[points.length - 1]).toMatchObject({ day: today.toISOString().slice(0, 10), credits: 22, generations: 4 });
    expect(points.slice(0, -1).every((p) => p.credits === 0)).toBe(true);
    await expect(getUsageTimeseries(A.id, new Date("2020-01-01"), new Date("2021-06-01"))).rejects.toMatchObject({ code: "range_too_long" });
  });

  it("by member: the owner sees each person, with Asks apart from prompts", async () => {
    const rows = await getUsageByMember(A.id);
    const ada = rows.find((r) => r.userId === A.id)!;
    const bea = rows.find((r) => r.userId === B.id)!;
    expect(ada).toMatchObject({ isYou: true, prompts: 8, asks: 0, other: 9, total: 17 });
    expect(bea).toMatchObject({ isYou: false, name: "Bea Member", prompts: 0, asks: 5, total: 5 });
    expect(rows.reduce((a, r) => a + r.total, 0)).toBe(22);
  });

  it("history: one line per finished call (net cost), grants; titles only for workspaces still visible", async () => {
    const { entries, nextCursor } = await listCreditHistory(A.id);
    expect(nextCursor).toBeNull();
    const usage = entries.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(4); // the released call isn't listed
    expect(usage.reduce((a, e) => a + e.amount, 0)).toBe(-22);
    const answer = usage.find((e) => e.label === "text")!;
    expect(answer).toMatchObject({ amount: -8, workspaceTitle: expect.stringContaining("Marketing plan"), byOther: false });
    const ask = usage.find((e) => e.label === "asks")!;
    expect(ask).toMatchObject({ byOther: true, actorName: "Bea Member" });
    const review = usage.find((e) => e.label === "reviews")!;
    expect(review.workspaceTitle).toBeNull(); // deleted workspace
    expect(entries.find((e) => e.type === "grant")).toMatchObject({ label: "signupGrant", amount: 100 });

    const grantsOnly = await listCreditHistory(A.id, { type: "grants" });
    expect(grantsOnly.entries.every((e) => e.type === "grant")).toBe(true);
  });

  it("history pages with a cursor without gaps or repeats", async () => {
    const first = await listCreditHistory(A.id, { limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const rest = await listCreditHistory(A.id, { limit: 50, cursor: first.nextCursor! });
    const all = await listCreditHistory(A.id);
    expect([...first.entries, ...rest.entries].map((e) => e.id)).toEqual(all.entries.map((e) => e.id));
  });

  it("CSV: labels, and a workspace title can't run as a spreadsheet formula", async () => {
    const { entries } = await listCreditHistory(A.id);
    const t = (k: string) => k.split(".").pop()!;
    const csv = creditHistoryCsv(entries, t);
    expect(csv.split("\r\n")[0]).toContain('"date"');
    expect(csv).toContain(`"'=HYPERLINK(""x"") Marketing plan"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
    expect(csvCell(-8)).toBe("-8");
  });

  it("a new allowance starts a new period; the previous one keeps its numbers", async () => {
    await db.$transaction((tx) => grantPlanInTx(tx, accountId, 100, "free_monthly", `free:${A.id}:next-${sfx}`));
    const now = await getUsageSummary(A.id, "current");
    expect(now.used).toBe(0);
    expect(now.hasPreviousPeriod).toBe(true);
    const prev = await getUsageSummary(A.id, "prev");
    expect(prev.used).toBe(22);
    expect(prev.periodEnd).not.toBeNull();
  });

  it("an empty account renders sensible zeros", async () => {
    const s = await getUsageSummary(C.id);
    expect(s).toMatchObject({ used: 0, remaining: 100, generations: 0, hasPreviousPeriod: false, byModel: [] });
    expect(await getUsageByMember(C.id)).toEqual([]);
    const h = await listCreditHistory(C.id);
    expect(h.entries.map((e) => e.label)).toEqual(["signupGrant"]);
  });

  it("breakdown never counts a search surcharge above what the call cost", () => {
    const out = breakdown([
      { generation_id: "x", kind: "TEXT", model_key: "text-economy", actor_id: "a", usage: { searches: 5 }, credits: 4 },
    ]);
    expect(out.webSearch.credits).toBe(4);
    expect(out.byKind.text).toBe(0);
  });
});

describe("Step 9.3 — routes: own account only", () => {
  it("401 without a session on every endpoint", async () => {
    for (const call of [
      () => summaryRoute(req("/api/v1/me/usage/summary")),
      () => timeseriesRoute(req("/api/v1/me/usage/timeseries")),
      () => byMemberRoute(req("/api/v1/me/usage/by-member")),
      () => historyRoute(req("/api/v1/me/credits/history")),
      () => historyRoute(req("/api/v1/me/credits/history?format=csv")),
    ]) {
      expect((await call()).status).toBe(401);
    }
  });

  it("another person only ever gets their own numbers", async () => {
    mockActor = asActor(C);
    const summary = await (await summaryRoute(req("/api/v1/me/usage/summary"))).json();
    expect(summary.data.used).toBe(0);
    const members = await (await byMemberRoute(req("/api/v1/me/usage/by-member"))).json();
    expect(members.data.members).toEqual([]);
    const history = await (await historyRoute(req("/api/v1/me/credits/history"))).json();
    expect(history.data.entries.every((e: { type: string }) => e.type === "grant")).toBe(true);
  });

  it("validates the query and downloads CSV", async () => {
    mockActor = asActor(A);
    expect((await summaryRoute(req("/api/v1/me/usage/summary?period=lifetime"))).status).toBe(422);
    expect((await timeseriesRoute(req("/api/v1/me/usage/timeseries?from=yesterday"))).status).toBe(422);
    const ts = await (await timeseriesRoute(req("/api/v1/me/usage/timeseries"))).json();
    expect(ts.data.points).toHaveLength(30);
    const csv = await historyRoute(req("/api/v1/me/credits/history?format=csv"));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
  });
});
