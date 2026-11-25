import "server-only";
import { AiError, type AiErrorCategory, type AiProvider, type GenerateRequest, type ImageRequest, type ImageResult, type Msg, type StreamEvent } from "../types";

/**
 * Step 10.4 — a fake AI provider for end-to-end tests, local demos and load
 * tests: `AI_PROVIDER=fake` (refused when NODE_ENV=production, `server/env.ts`).
 * It never calls a network and is **deterministic**: the same request gives
 * the same stream. It recognises what each Klecx feature asks for and answers
 * in the shape that feature parses:
 *
 * - answers / Asks: a thought, then a fixed Markdown answer streamed in small
 *   pieces (with a short pause, so streaming is visible), then usage;
 * - titles: a short title;
 * - the question queue (`responseSchema` with `id`/`answer`): one answer per
 *   `[Question ID: …]` in the prompt;
 * - document reviews (`responseSchema` with `exact`): a fix for each known
 *   misspelling in the chunk (`teh`, `recieve`, `seperate`), else [];
 * - voice input (an audio/file part): a fixed transcript;
 * - the web-search step (`grounding: true`): a summary and one source.
 *
 * Directives in the last user message, for tests:
 * - `[[fake:error:<category>]]` → throws that AiError (`rate_limit`,
 *   `unavailable`, `timeout` are retryable; `auth`, `safety`,
 *   `invalid_request`, `unknown` are not);
 * - `[[fake:search]]` → calls the `web_search` tool once (when offered);
 * - `[[fake:docx]]` / `[[fake:pdf]]` / `[[fake:md]]` → calls `create_document`
 *   once (when offered);
 * - `[[fake:slow]]` → 150 ms between pieces (to test Stop).
 */

export const FAKE_TRANSCRIPT = "This is a fake transcript from the test voice provider.";
export const FAKE_TITLE = "Fake test workspace title";
export const FAKE_SEARCH_SOURCE = { url: "https://example.com/fake-source", title: "Fake source" };
const TYPOS: Record<string, string> = { teh: "the", recieve: "receive", seperate: "separate" };
const RETRYABLE: AiErrorCategory[] = ["rate_limit", "unavailable", "timeout"];

/** The fixed answer (Markdown) for a question; the snippet makes answers to different prompts differ. */
export function fakeAnswer(question: string): string {
  // The last line of the prompt: the question itself (an Ask's prompt starts with its context).
  const lines = question.replace(/\[\[fake:[^\]]*\]\]/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const snippet = (lines[lines.length - 1] ?? "").replace(/\s+/g, " ").slice(0, 80);
  return [
    `Here is a test answer about "${snippet || "your question"}".`,
    "",
    "The **first paragraph** explains the idea in plain words. It has enough text to highlight a passage and ask about it.",
    "",
    "- Point one: the main idea.",
    "- Point two: a supporting detail.",
    "",
    "A closing sentence ends the answer.",
  ].join("\n");
}

function textOf(msg: Msg | undefined): string {
  return (msg?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
}

function lastUser(req: GenerateRequest): Msg | undefined {
  return [...req.messages].reverse().find((m) => m.role === "user");
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });

function tokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

function inputChars(req: GenerateRequest): number {
  return (req.system?.length ?? 0) + req.messages.reduce((n, m) => n + textOf(m).length, 0);
}

function schemaHas(req: GenerateRequest, prop: string): boolean {
  const s = req.responseSchema as { items?: { properties?: Record<string, unknown> } } | undefined;
  return Boolean(s?.items?.properties && prop in s.items.properties);
}

function questionBatchAnswer(prompt: string): string {
  const out: Array<{ id: string; answer: string }> = [];
  const re = /\[Question ID: ([^\]]+)\][^\n]*\n\s*Highlighted Passage: «([^»]*)»[^\n]*\n\s*Question: ([^\n]*)/g;
  for (const m of prompt.matchAll(re)) {
    out.push({ id: m[1]!.trim(), answer: `Fake answer to "${m[3]!.trim()}" about «${m[2]!.trim().slice(0, 60)}».` });
  }
  return JSON.stringify(out);
}

function reviewAnswer(prompt: string): string {
  const findings: unknown[] = [];
  for (const [typo, fix] of Object.entries(TYPOS)) {
    const re = new RegExp(`\\b${typo}\\b`, "g");
    for (const m of prompt.matchAll(re)) {
      const at = m.index!;
      findings.push({
        exact: typo,
        prefix: prompt.slice(Math.max(0, at - 20), at),
        suffix: prompt.slice(at + typo.length, at + typo.length + 20),
        comment: `"${typo}" is misspelled.`,
        category: "spelling",
        severity: "low",
        replacement: fix,
      });
      if (findings.length >= 5) break;
    }
  }
  return JSON.stringify(findings);
}

export class FakeAiProvider implements AiProvider {
  // Reported as "gemini" so code that branches on the provider id behaves as in production.
  readonly id = "gemini" as const;

  constructor(private readonly opts: { delayMs?: number } = {}) {}

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const user = lastUser(req);
    const prompt = textOf(user);
    const delay = prompt.includes("[[fake:slow]]") ? 150 : (this.opts.delayMs ?? 15);

    const error = prompt.match(/\[\[fake:error:([a-z_]+)\]\]/);
    if (error) {
      const category = error[1] as AiErrorCategory;
      throw new AiError(category, RETRYABLE.includes(category), `Fake ${category} error`);
    }

    // After a tool ran, the model writes its closing text.
    const toolResponse = user?.parts.find((p) => p.type === "tool_response");
    const offered = new Set((req.tools ?? []).map((t) => t.name));

    let text: string;
    let thought: string | null = null;
    let searchQueries: number | undefined;

    if (toolResponse && toolResponse.type === "tool_response") {
      text = toolResponse.name === "create_document"
        ? "The document is ready. It contains a short test text with a title and two paragraphs."
        : `According to the search, the test fact is confirmed [1].`;
    } else if (/^Transcribe this audio/.test(prompt.trim()) || user?.parts.some((p) => p.type === "audio")) {
      text = FAKE_TRANSCRIPT;
    } else if (req.grounding) {
      yield { type: "citation", url: FAKE_SEARCH_SOURCE.url, title: FAKE_SEARCH_SOURCE.title, source: "GROUNDING" };
      text = "Fake search summary: the test fact was confirmed on 25 November 2026 at 12:00 UTC.";
      searchQueries = 1;
    } else if (schemaHas(req, "id") && schemaHas(req, "answer")) {
      text = questionBatchAnswer(prompt);
    } else if (schemaHas(req, "exact")) {
      text = reviewAnswer(prompt);
    } else if (/concise 3 to 6 word title/i.test(prompt)) {
      text = FAKE_TITLE;
    } else {
      const docFormat = prompt.match(/\[\[fake:(docx|pdf|md)\]\]/)?.[1];
      if (docFormat && offered.has("create_document")) {
        yield {
          type: "tool_call",
          name: "create_document",
          args: {
            format: docFormat,
            title: "Fake test document",
            markdown: "# Fake test document\n\nThe first paragraph of the test document.\n\nThe second paragraph, with teh typo for reviews.",
          },
        };
        yield { type: "usage", inputTokens: tokens(inputChars(req)), outputTokens: 40, estimated: false };
        yield { type: "done", finishReason: "tool" };
        return;
      }
      if (prompt.includes("[[fake:search]]") && offered.has("web_search")) {
        yield { type: "tool_call", name: "web_search", args: { query: "fake test fact 25 November 2026" } };
        yield { type: "usage", inputTokens: tokens(inputChars(req)), outputTokens: 10, estimated: false };
        yield { type: "done", finishReason: "tool" };
        return;
      }
      thought = "Reading the question and planning a short answer.";
      text = fakeAnswer(prompt);
      // Which answer language the request asked for (journey 9): the
      // Settings preference in the instructions, or an explicit request in the prompt.
      const asked = prompt.match(/\b(?:answer|reply|respond) in (English|Spanish|French|German|Portuguese)\b/i)?.[1];
      const preferred = req.system?.match(/Response language: ([A-Za-z]+)\./)?.[1];
      text += asked
        ? `\n\n(Answering in ${asked[0]!.toUpperCase()}${asked.slice(1).toLowerCase()}, as asked.)`
        : preferred
          ? `\n\n(Answering in ${preferred}.)`
          : "\n\n(Answering in the language of your message.)";
      // Shows that attachments reached the model (journey 5).
      const lastTurn = user?.parts ?? [];
      const files =
        lastTurn.filter((p) => p.type === "image" || p.type === "file").length +
        lastTurn.reduce((n, p) => n + (p.type === "text" ? (p.text.match(/<document name="/g) ?? []).length : 0), 0);
      if (files > 0) text += `\n\nI looked at ${files} attached file${files === 1 ? "" : "s"}.`;
    }

    if (thought && req.thinking?.summaries) {
      yield { type: "thought_delta", text: thought };
      await sleep(delay, req.signal);
    }

    // Small pieces, so the browser sees the answer stream in.
    const pieces = text.match(/[\s\S]{1,24}/g) ?? [];
    for (const piece of pieces) {
      if (delay > 0) await sleep(delay, req.signal);
      yield { type: "text_delta", text: piece };
    }
    yield {
      type: "usage",
      inputTokens: tokens(inputChars(req)),
      outputTokens: tokens(text.length),
      thoughtTokens: thought ? tokens(thought.length) : 0,
      ...(text === FAKE_TRANSCRIPT ? { audioInputTokens: 32 } : {}),
      ...(searchQueries ? { searchQueries } : {}),
      estimated: false,
    };
    yield { type: "done", finishReason: "stop" };
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    void req;
    // A 1×1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64"
    );
    return { bytes: png, mime: "image/png", usage: { images: 1 } };
  }
}
