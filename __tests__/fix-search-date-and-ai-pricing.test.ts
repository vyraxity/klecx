/**
 * @jest-environment node
 *
 * Fix before Step 10.3 — "search date and AI prices":
 * today's date in every AI request and in the search step; search usage
 * (queries + the search request's tokens) recorded and costed; voice audio
 * priced at the audio rate; the 5-credit search surcharge in the copy; the
 * near-cap alert for the provider's 1,500-a-day search cap.
 */
import fs from "fs";
import { db } from "@/server/db/client";
import {
  createAndStreamGeneration,
  setCustomProvider,
  clearActiveGenerationsForTesting,
} from "@/server/services/generation";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { setUserPlanOverride, clearUserPlanOverrides } from "@/server/billing/plans";
import { creditsFor, GROUNDING_SURCHARGE_CREDITS, MODEL_CATALOG } from "@/lib/ai/model-catalog";
import {
  currentDateInstruction,
  formatPromptDate,
  searchDateInstruction,
  searchReportInstruction,
} from "@/lib/ai/date-context";
import { WEB_SEARCH_TOOL } from "@/server/ai/tools/web-search";
import { buildSystemPrompt } from "@/server/ai/prompts/system";
import { withCurrentDate } from "@/server/ai";
import { runWebSearch } from "@/server/ai/tools/web-search";
import { generationCostUsd, searchCostUsd, PROVIDER_SEARCH_USD } from "@/server/monitoring/costs";
import { countSearchRequests } from "@/server/monitoring/search-usage";
import { evaluateAlerts } from "@/server/monitoring/alerts";
import { computeMetrics } from "@/server/services/metrics";
import type { AiProvider, GenerateRequest, ImageResult, StreamEvent } from "@/server/ai/types";
import type { Actor } from "@/server/auth/session";

/** Records every request; the grounded search reports 2 queries and its tokens. */
class RecordingProvider implements AiProvider {
  id = "gemini" as const;
  requests: GenerateRequest[] = [];

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    if (req.grounding) {
      yield { type: "text_delta", text: "Matchday 11 results, 2026/27 season." };
      yield {
        type: "citation",
        url: "https://example.com/results",
        title: "Results",
        snippet: "As of today, Tuesday, 24 November 2026, our own summary text",
        source: "GROUNDING",
      };
      yield { type: "usage", inputTokens: 2_000, outputTokens: 400, thoughtTokens: 100, searchQueries: 2, estimated: false };
      return;
    }
    const searched = req.messages.some((m) => m.parts.some((p) => p.type === "tool_response"));
    if (req.tools?.some((t) => t.name === "web_search") && !searched) {
      yield { type: "tool_call", name: "web_search", args: { query: "Premier League matchday 11 results" } };
      return;
    }
    yield { type: "text_delta", text: "Here are the results." };
    yield { type: "usage", inputTokens: 1_000, outputTokens: 200, estimated: false };
  }

  async generateImage(): Promise<ImageResult> {
    throw new Error("unused");
  }
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // read to the end
  }
}

const NOW = new Date("2026-11-21T15:00:00Z");

describe("today's date in AI requests", () => {
  test("the wording", () => {
    expect(formatPromptDate(NOW)).toBe("Saturday, 21 November 2026");
    expect(currentDateInstruction(NOW)).toContain("Today is Saturday, 21 November 2026 (UTC).");
    const s = searchDateInstruction(NOW);
    expect(s).toContain("Today is Saturday, 21 November 2026");
    expect(s).toContain("names no year, season or date, search for the current one");
    expect(s).toContain("Prefer the most recent sources");
  });

  test("added at the end of the instructions, keeping the existing ones first", () => {
    expect(withCurrentDate({ modelKey: "x", messages: [], system: "Be helpful." }, NOW).system).toBe(
      `Be helpful.\n\n${currentDateInstruction(NOW)}`
    );
    expect(withCurrentDate({ modelKey: "x", messages: [] }, NOW).system).toBe(currentDateInstruction(NOW));
  });

  test("the search step gets the date and the current-events rule, and reports its usage", async () => {
    const provider = new RecordingProvider();
    const result = await runWebSearch("premier league matchday 11", { providerInstance: provider, now: NOW });
    const req = provider.requests[0]!;
    const text = req.messages[0]!.parts.find((p) => p.type === "text") as { text: string };
    expect(text.text.startsWith(searchDateInstruction(NOW))).toBe(true);
    expect(req.system).toContain("Today is Saturday, 21 November 2026");
    expect(result.usage).toEqual({ queries: 2, inputTokens: 2_000, outputTokens: 500 });
  });

  test("the date line can't be mistaken for a test date (owner's report, 2026-11-24)", () => {
    const line = currentDateInstruction(NOW);
    expect(line).toContain("comes from the system clock and is correct");
    expect(line).toContain("placeholder");
    expect(line).toContain('"next", "upcoming"');
    expect(searchDateInstruction(NOW)).toContain("Turn relative words");
  });

  test("the search step keeps dates, times and time zones exactly, and gives complete lists", async () => {
    const provider = new RecordingProvider();
    const result = await runWebSearch("premier league fixtures 27-30 November 2026", {
      providerInstance: provider,
      now: NOW,
    });
    const text = (provider.requests[0]!.messages[0]!.parts.find((p) => p.type === "text") as { text: string }).text;
    expect(text).toContain(searchReportInstruction());
    expect(searchReportInstruction()).toContain("with its time zone");
    expect(searchReportInstruction()).toContain("complete list");
    expect(searchReportInstruction()).toContain("If sources disagree");
    // The provider's snippet is our own summary text: never kept as the source's words.
    expect(result.sources).toEqual([
      expect.objectContaining({ url: "https://example.com/results", title: "Results" }),
    ]);
    expect(result.sources[0]!.snippet).toBeUndefined();
  });

  test("the search tool asks for queries with actual dates; answers keep times with their time zone", () => {
    expect(WEB_SEARCH_TOOL.description).toContain("put the actual dates");
    expect(buildSystemPrompt("auto")).toContain("each time with its time zone");
  });

  test("source cards don't show web-search snippets (old answers stored our summary as one)", () => {
    const src = fs.readFileSync("components/response/citations.tsx", "utf8");
    expect(src).toContain('c.source === "GROUNDING" ? null : c.snippet');
    expect(src).not.toMatch(/\{c(itation|it)\.snippet\}/);
  });

  test("not the read-aloud voice (it would read the date out loud)", () => {
    expect(fs.readFileSync("server/speech/gemini-tts.ts", "utf8")).not.toContain("currentDateInstruction");
  });
});

describe("an answer with a web search (end to end)", () => {
  let actor: Actor;
  let workspaceId = "";
  let provider: RecordingProvider;

  beforeAll(async () => {
    clearActiveGenerationsForTesting();
    clearUserPlanOverrides();
    provider = new RecordingProvider();
    setCustomProvider(provider);
    const id = `fix_sd_${Date.now()}`;
    const user = await db.user.create({ data: { id, name: "Search", email: `${id}@example.com`, emailVerified: true } });
    actor = { userId: user.id, email: user.email, role: "USER", sessionId: `s_${id}` } as Actor;
    const acc = await createAccountWithFreeGrant(user.id);
    await db.creditAccount.update({ where: { id: acc.id }, data: { topupBalance: 200 } });
    workspaceId = (await db.workspace.create({ data: { ownerId: user.id, title: "Search" } })).id;
    setUserPlanOverride(user.id, "LITE");
  });

  afterAll(() => setCustomProvider(null));

  test("every request carries the date; usage records the queries and the search's tokens; 5 credits per search", async () => {
    const before = await db.creditAccount.findUniqueOrThrow({ where: { userId: actor.userId } });
    const { stream } = await createAndStreamGeneration(actor, workspaceId, {
      idempotencyKey: `idem_${Date.now()}`,
      prompt: "Results of the current Premier League matchday 11?",
      modelKey: "text-economy",
      kind: "TEXT",
    });
    await drain(stream);

    // Answer turns and the search step all have today's date in their instructions.
    const today = formatPromptDate(new Date());
    expect(provider.requests.length).toBeGreaterThanOrEqual(3);
    for (const r of provider.requests) expect(r.system ?? "").toContain(`Today is ${today} (UTC).`);

    const gen = await db.generation.findFirstOrThrow({ where: { workspaceId, kind: "TEXT" }, orderBy: { createdAt: "desc" } });
    expect(gen.usage).toMatchObject({ searches: 1, searchQueries: 2, searchInputTokens: 2_000, searchOutputTokens: 500 });

    // Credits: the answer's tokens + 5 per search; the search's own tokens aren't charged.
    const after = await db.creditAccount.findUniqueOrThrow({ where: { userId: actor.userId } });
    const spent = before.planBalance + before.topupBalance - (after.planBalance + after.topupBalance);
    expect(spent).toBe(creditsFor("text-economy", { inputTokens: 1_000, outputTokens: 200 }) + 5);

    // Provider cost: answer tokens + 2 queries × $0.014 + the search's tokens.
    const answerTokens = (1_000 * 0.25 + 200 * 1.5) / 1e6;
    const searchTokens = (2_000 * 0.25 + 500 * 1.5) / 1e6;
    expect(generationCostUsd(gen)).toBeCloseTo(answerTokens + 2 * 0.014 + searchTokens, 10);
  });
});

describe("prices", () => {
  test("the surcharge is 5 credits and the copy says so in every language", () => {
    expect(GROUNDING_SURCHARGE_CREDITS).toBe(5);
    for (const locale of ["en", "es", "fr"]) {
      const m = JSON.parse(fs.readFileSync(`messages/${locale}.json`, "utf8"));
      for (const text of [m.Settings.ai.searchHint, m.Marketing.faq.items.creditDef.a, m.Marketing.faq.items.creditDef.aTextOnly]) {
        expect([locale, text.includes(` ${GROUNDING_SURCHARGE_CREDITS} cr`)]).toEqual([locale, true]);
        expect([locale, /\b3 cr[ée]/.test(text)]).toEqual([locale, false]);
      }
    }
  });

  test("Standard Reasoning keeps $1.50 / $7.50 (owner, 2026-11-24)", () => {
    expect(MODEL_CATALOG["text-standard"].priceUsdPerM).toEqual({ in: 1.5, out: 7.5 });
  });

  test("voice input: audio at $0.50 per 1M tokens, text at $0.25", () => {
    // 1,000,000 audio + 1,000,000 text tokens in, nothing out: $0.50 + $0.25 = $0.75 → 375 credits.
    expect(creditsFor("audio-transcribe", { inputTokens: 2_000_000, audioInputTokens: 1_000_000 })).toBe(375);
    expect(creditsFor("audio-transcribe", { inputTokens: 2_000_000 })).toBe(250);
    expect(
      generationCostUsd({ kind: "TRANSCRIPTION", modelKey: "audio-transcribe", status: "COMPLETED", usage: { inputTokens: 2_000_000, audioInputTokens: 1_000_000 }, createdAt: NOW })
    ).toBeCloseTo(0.75, 10);
    expect(fs.readFileSync("server/services/transcription.ts", "utf8")).toContain("audioInputTokens");
  });

  test("search cost: queries × $0.014 + the search's tokens; old rows count one query per search", () => {
    expect(PROVIDER_SEARCH_USD).toBe(0.014);
    expect(searchCostUsd({ searches: 1, searchQueries: 3, searchInputTokens: 1_000_000, searchOutputTokens: 0 })).toBeCloseTo(3 * 0.014 + 0.25, 10);
    expect(searchCostUsd({ searches: 2 })).toBeCloseTo(2 * 0.014, 10);
  });
});

describe("the provider's daily search cap and the free monthly allowance", () => {
  const sfx = `${Date.now()}`.slice(-7);
  const uid = `fix_cap_${sfx}`;
  const acc = `fix_cap_acc_${sfx}`;
  const DAY = new Date("2002-05-10T12:00:00Z");

  beforeAll(async () => {
    await db.user.create({ data: { id: uid, name: "Cap", email: `${uid}@example.com`, emailVerified: true } });
    await db.creditAccount.create({ data: { id: acc, userId: uid } });
  });
  afterAll(async () => {
    await db.generation.deleteMany({ where: { actorId: uid } });
    await db.creditAccount.deleteMany({ where: { id: acc } });
    await db.user.deleteMany({ where: { id: uid } });
  });

  async function seedSearches(count: number, at: Date) {
    // One generation per 100 searches keeps the seed small; the counter sums `usage.searches`.
    const rows = [];
    for (let left = count; left > 0; left -= 100) {
      rows.push({
        actorId: uid, billedAccountId: acc, kind: "TEXT" as const, status: "COMPLETED" as const,
        modelKey: "text-economy", providerModelId: "x", promptVersion: "1",
        idempotencyKey: `cap_${sfx}_${crypto.randomUUID()}`, createdAt: at,
        usage: { inputTokens: 0, outputTokens: 0, searches: Math.min(100, left), searchQueries: Math.min(100, left) * 2 },
      });
    }
    await db.generation.createMany({ data: rows });
  }

  test("counts requests and queries; warning at 80 %, critical at the cap", async () => {
    await seedSearches(1_200, new Date(DAY.getTime() - 60 * 60_000));
    expect(await countSearchRequests(new Date("2002-05-10Z"), new Date("2002-05-11Z"))).toEqual({ requests: 1_200, queries: 2_400 });

    let keys = (await evaluateAlerts(DAY)).map((a) => a.key);
    expect(keys).toContain("search_cap_near");
    expect(keys).not.toContain("search_cap_reached");

    await seedSearches(300, new Date(DAY.getTime() - 30 * 60_000));
    const alerts = await evaluateAlerts(DAY);
    keys = alerts.map((a) => a.key);
    expect(keys).toContain("search_cap_reached");
    expect(keys).not.toContain("search_cap_near");
    expect(alerts.find((a) => a.key === "search_cap_reached")).toMatchObject({ severity: "critical", values: { requests: 1_500, cap: 1_500 } });

    // The next UTC day starts from zero.
    expect((await evaluateAlerts(new Date("2002-05-11T01:00:00Z"))).map((a) => a.key)).not.toContain("search_cap_near");
  });

  test("the metrics show the month's searches against the 5,000 free", async () => {
    const m = await computeMetrics(new Date("2002-05-10Z"), new Date("2002-05-11Z"));
    expect(m.searches).toMatchObject({ executed: 1_500, queries: 3_000 });
    expect(m.searches.monthToDate).toEqual({ month: "2002-05", requests: 1_500, queries: 3_000, freeRequests: 5_000, freeRemaining: 3_500 });
    expect(m.searches.providerUsd).toBeCloseTo(3_000 * 0.014, 6);
  });

  test("alert texts exist in every language", () => {
    for (const locale of ["en", "es", "fr"]) {
      const kinds = JSON.parse(fs.readFileSync(`messages/${locale}.json`, "utf8")).Email.monitoringAlert.kinds;
      expect(kinds.searchCapNear).toContain("{cap}");
      expect(kinds.searchCapReached).toContain("{requests}");
    }
  });
});
