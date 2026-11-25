/**
 * @jest-environment node
 *
 * Step 10.4 — the fake AI provider, the test-mode guards in `server/env.ts`,
 * the test-only endpoints (404 outside test mode), the test inbox, and the
 * fake Creem checkout that sends signed webhooks through the real handler.
 */
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { env, validateEnv } from "@/server/env";
import { FakeAiProvider, FAKE_TRANSCRIPT, FAKE_TITLE, fakeAnswer } from "@/server/ai/providers/fake";
import type { GenerateRequest, StreamEvent } from "@/server/ai/types";
import { questionBatchResponseSchema } from "@/server/ai/prompts/question-batch";
import { documentReviewResponseSchema } from "@/server/ai/prompts/document-review";
import { FakeSpeechProvider } from "@/server/speech/gemini-tts";
import { createCreemProvider } from "@/server/billing/creem";
import { setBillingProviderForTests } from "@/server/billing/get-provider";
import { completeFakeCheckout, fakeCreemFetch, readTestEmails, recordTestEmail } from "@/server/testing/e2e";
import { sendEmail } from "@/server/email/send";
import { GET as testGET, POST as testPOST } from "@/app/api/test/[action]/route";

jest.mock("../server/auth/session", () => ({ getActor: jest.fn(async () => null) }));

const fake = new FakeAiProvider({ delayMs: 0 });

async function collect(req: Partial<GenerateRequest>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of fake.stream({ modelKey: "x", messages: [], ...req } as GenerateRequest)) out.push(e);
  return out;
}
const text = (events: StreamEvent[]) =>
  events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
const user = (t: string): GenerateRequest["messages"] => [{ role: "user", parts: [{ type: "text", text: t }] }];

describe("fake AI provider", () => {
  test("answers deterministically, streams in pieces, thinks only when asked, reports usage", async () => {
    const a = await collect({ messages: user("Explain tides"), thinking: { summaries: true } });
    const b = await collect({ messages: user("Explain tides"), thinking: { summaries: true } });
    expect(text(a)).toBe(text(b));
    expect(text(a)).toContain(fakeAnswer("Explain tides"));
    expect(a.filter((e) => e.type === "text_delta").length).toBeGreaterThan(3);
    expect(a[0]!.type).toBe("thought_delta");
    expect(a.find((e) => e.type === "usage")).toMatchObject({ estimated: false });
    expect(a[a.length - 1]).toEqual({ type: "done", finishReason: "stop" });
    const quiet = await collect({ messages: user("Explain tides") });
    expect(quiet.some((e) => e.type === "thought_delta")).toBe(false);
  });

  test("states the answer language it was asked for", async () => {
    expect(text(await collect({ messages: user("Hi"), system: "Response language: Spanish. If the user…" }))).toContain("(Answering in Spanish.)");
    expect(text(await collect({ messages: user("Hi, answer in German"), system: "Response language: Spanish." }))).toContain("(Answering in German, as asked.)");
    expect(text(await collect({ messages: user("Hi") }))).toContain("(Answering in the language of your message.)");
  });

  test("answers each queued question by id, and reviews typos as JSON findings", async () => {
    const batch = "- [Question ID: q1]\n  Highlighted Passage: «alpha»\n  Question: Why?\n\n- [Question ID: q2]\n  Highlighted Passage: «beta»\n  Question: How?\n";
    const answers = JSON.parse(text(await collect({ messages: user(batch), responseSchema: questionBatchResponseSchema })));
    expect(answers.map((a: { id: string }) => a.id)).toEqual(["q1", "q2"]);
    const findings = JSON.parse(text(await collect({ messages: user("Welcome to teh team."), responseSchema: documentReviewResponseSchema })));
    expect(findings).toEqual([expect.objectContaining({ exact: "teh", replacement: "the", prefix: "Welcome to ", suffix: " team." })]);
    expect(JSON.parse(text(await collect({ messages: user("All fine."), responseSchema: documentReviewResponseSchema })))).toEqual([]);
  });

  test("titles, transcripts, grounded search with a source, attachments", async () => {
    expect(text(await collect({ messages: user("Summarize the following user request into a concise 3 to 6 word title.") }))).toBe(FAKE_TITLE);
    expect(text(await collect({ messages: user("Transcribe this audio verbatim in the language spoken.") }))).toBe(FAKE_TRANSCRIPT);
    const search = await collect({ messages: user("Search query: x"), grounding: true });
    expect(search.find((e) => e.type === "citation")).toMatchObject({ url: "https://example.com/fake-source" });
    expect(search.find((e) => e.type === "usage")).toMatchObject({ searchQueries: 1 });
    const withFiles = await collect({
      messages: [{ role: "user", parts: [{ type: "image", url: "data:image/png;base64,AA", mime: "image/png" }, { type: "text", text: '<document name="a.pdf">x</document>\nSummarise' }] }],
    });
    expect(text(withFiles)).toContain("I looked at 2 attached files.");
  });

  test("directives: errors on demand, tool calls only when offered, closing text after a tool", async () => {
    await expect(collect({ messages: user("x [[fake:error:rate_limit]]") })).rejects.toMatchObject({ category: "rate_limit", retryable: true });
    await expect(collect({ messages: user("x [[fake:error:auth]]") })).rejects.toMatchObject({ category: "auth", retryable: false });
    const doc = await collect({ messages: user("Write it [[fake:docx]]"), tools: [{ name: "create_document" }] });
    expect(doc.find((e) => e.type === "tool_call")).toMatchObject({ name: "create_document", args: expect.objectContaining({ format: "docx" }) });
    const notOffered = await collect({ messages: user("Write it [[fake:docx]]") });
    expect(notOffered.some((e) => e.type === "tool_call")).toBe(false);
    const search = await collect({ messages: user("News [[fake:search]]"), tools: [{ name: "web_search" }] });
    expect(search.find((e) => e.type === "tool_call")).toMatchObject({ name: "web_search" });
    const after = await collect({
      messages: [...user("Write it"), { role: "user", parts: [{ type: "tool_response", name: "create_document", response: { ok: true } }] }],
    });
    expect(text(after)).toContain("The document is ready.");
  });

  test("the fake voice gives a WAV whose length follows the text", async () => {
    const voice = new FakeSpeechProvider();
    const id = voice.listVoices()[0]!.id;
    const short = await voice.synthesize({ text: "Hi.", voiceId: id });
    const long = await voice.synthesize({ text: "A much longer sentence to read aloud for the test.", voiceId: id });
    expect(short.audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(long.usage.audioSeconds).toBeGreaterThan(short.usage.audioSeconds);
  });
});

describe("test-mode guards (server/env.ts)", () => {
  const base = {
    APP_URL: "http://localhost:3100",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(40),
    GEMINI_API_KEY: "dummy-key-0000",
    RESEND_API_KEY: "re_dummy",
    EMAIL_FROM: "Klecx <x@example.com>",
    SUPPORT_EMAIL: "s@example.com",
    PRIVACY_EMAIL: "p@example.com",
    ABUSE_EMAIL: "a@example.com",
    COMPANY_LEGAL_NAME: "X",
    COMPANY_ADDRESS: "Y",
    COMPANY_COUNTRY: "NG",
  };
  test("the fake AI is refused in a production deployment and on Vercel", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "production", AI_PROVIDER: "fake", UPSTASH_REDIS_REST_URL: "https://r.example.com", UPSTASH_REDIS_REST_TOKEN: "t" })).toThrow(/AI_PROVIDER/);
    expect(() => validateEnv({ ...base, NODE_ENV: "development", AI_PROVIDER: "fake", VERCEL: "1" })).toThrow(/AI_PROVIDER/);
    expect(validateEnv({ ...base, NODE_ENV: "development", AI_PROVIDER: "fake" }).AI_PROVIDER).toBe("fake");
  });
  test("E2E_TEST_MODE: allowed for a local production build (no Redis needed), refused on Vercel", () => {
    const local = validateEnv({ ...base, NODE_ENV: "production", E2E_TEST_MODE: "true", AI_PROVIDER: "fake" });
    expect(local.E2E_TEST_MODE).toBe(true);
    expect(() => validateEnv({ ...base, NODE_ENV: "production", E2E_TEST_MODE: "true", VERCEL: "1" })).toThrow(/E2E_TEST_MODE/);
    expect(() => validateEnv({ ...base, NODE_ENV: "production" })).toThrow(/UPSTASH/);
    expect(validateEnv({ ...base, NODE_ENV: "development" }).E2E_TEST_MODE).toBe(false);
  });
});

describe("test-only endpoints", () => {
  const req = (url: string, method = "GET", body?: unknown) =>
    new NextRequest(`http://localhost:3000${url}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });

  test("answer 404 when test mode is off (every deployment)", async () => {
    expect(env.E2E_TEST_MODE).toBe(false);
    for (const action of ["emails", "creem-checkout"]) {
      const res = await testGET(req(`/api/test/${action}`), { params: Promise.resolve({ action }) });
      expect(res.status).toBe(404);
    }
    for (const action of ["subscribe", "subscription-event"]) {
      const res = await testPOST(req(`/api/test/${action}`, "POST", { email: "a@example.com", plan: "PRO" }), { params: Promise.resolve({ action }) });
      expect(res.status).toBe(404);
    }
  });
});

describe("test inbox and fake Creem", () => {
  const sfx = Date.now().toString(36);
  const userId = `e2e_mode_${sfx}`;
  const mutableEnv = env as unknown as Record<string, unknown>;
  const saved = { mode: env.E2E_TEST_MODE, secret: env.CREEM_WEBHOOK_SECRET };

  beforeAll(async () => {
    await db.user.create({ data: { id: userId, name: "Mode", email: `${userId}@example.com`, emailVerified: true } });
  });
  afterAll(async () => {
    mutableEnv.E2E_TEST_MODE = saved.mode;
    mutableEnv.CREEM_WEBHOOK_SECRET = saved.secret;
    setBillingProviderForTests(undefined);
    await db.billingEvent.deleteMany({ where: { userId } });
    await db.notification.deleteMany({ where: { userId } });
    await db.subscription.deleteMany({ where: { userId } });
    await db.creditAccount.deleteMany({ where: { userId } });
    await db.billingCheckout.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("in test mode, emails go to the inbox with their links, never to the provider", async () => {
    mutableEnv.E2E_TEST_MODE = true;
    try {
      const res = await sendEmail("verify-email", `inbox_${sfx}@example.com`, { url: "http://localhost:3100/api/auth/verify-email?token=t&a=1" } as never);
      expect(res.success).toBe(true);
    } finally {
      mutableEnv.E2E_TEST_MODE = saved.mode;
    }
    const [mail] = readTestEmails(`inbox_${sfx}@example.com`);
    expect(mail).toMatchObject({ template: "verify-email" });
    expect(mail!.links).toContain("http://localhost:3100/api/auth/verify-email?token=t&a=1");
    recordTestEmail({ to: "other@example.com", template: "x", subject: "s", text: "no links" });
    expect(readTestEmails(`inbox_${sfx}@example.com`)).toHaveLength(1);
  });

  test("a fake checkout sends signed webhooks through the real handler: the plan starts with its credits", async () => {
    mutableEnv.CREEM_WEBHOOK_SECRET = "whsec_unit_e2e";
    const products = {
      LITE: { month: "prod_u_lite_m", year: "prod_u_lite_y" },
      STANDARD: { month: "prod_u_std_m", year: "prod_u_std_y" },
      PRO: { month: "prod_u_pro_m", year: "prod_u_pro_y" },
    };
    setBillingProviderForTests(
      createCreemProvider({ apiKey: "creem_test_unit", apiBase: "https://test-api.creem.io", webhookSecret: "whsec_unit_e2e", products }, fakeCreemFetch)
    );
    const requestId = `req_unit_${sfx}`;
    await db.billingCheckout.create({ data: { id: requestId, userId, plan: "LITE", interval: "month" } });
    const res = await fakeCreemFetch("https://test-api.creem.io/v1/checkouts", {
      method: "POST",
      body: JSON.stringify({ product_id: "prod_u_lite_m", request_id: requestId, success_url: "http://localhost:3000/settings/billing", metadata: { userId, plan: "LITE", interval: "month" } }),
    });
    const { id, checkout_url } = (await res.json()) as { id: string; checkout_url: string };
    expect(checkout_url).toContain("/api/test/creem-checkout?checkout=");
    const back = await completeFakeCheckout(id);
    expect(back).toContain("/settings/billing?checkout_id=");
    const sub = await db.subscription.findUniqueOrThrow({ where: { userId } });
    expect(sub).toMatchObject({ plan: "LITE", status: "ACTIVE" });
    expect((await db.creditAccount.findUniqueOrThrow({ where: { userId } })).planBalance).toBe(800);
    // The same checkout can't be completed twice.
    expect(await completeFakeCheckout(id)).toBeNull();
    // Creem answers a subscription lookup in its own shape (used by reconcile-billing).
    const looked = await fakeCreemFetch(`https://test-api.creem.io/v1/subscriptions?subscription_id=${sub.providerSubscriptionId}`, { method: "GET" });
    expect((await looked.json()).status).toBe("active");
  });
});
