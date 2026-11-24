import "server-only";
import { type ToolSpec, type AiProvider } from "../types";
import { streamAi } from "../index";
import { validateCitationUrl, type CitationSegment } from "../citations";
import { searchDateInstruction, searchReportInstruction } from "@/lib/ai/date-context";

export const WEB_SEARCH_TOOL: ToolSpec = {
  name: "web_search",
  description:
    "Search the web for current or verifiable information. Use it for recent events, prices, statistics, documentation or anything you are not sure about. Do not use it for general knowledge, writing or math. Write specific queries: for anything time-related, put the actual dates, season or year in the query (e.g. \"Premier League fixtures 27-30 November 2026\"), never only words like \"next\" or \"upcoming\".",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query to look up on the web.",
      },
    },
    required: ["query"],
  },
};

export interface WebSearchSource {
  url: string;
  title?: string;
  /**
   * Not filled for grounded searches: the provider's "snippet" is a piece of
   * our own summary, not text from the page, so showing it under the source
   * would put words in the source's mouth (owner's report, 2026-11-24).
   */
  snippet?: string;
  /** Where in `summary` this source is used (from the provider's grounding). */
  segments?: CitationSegment[];
}

/** What the search request itself used (recorded on the answer; not charged as tokens). */
export interface WebSearchUsage {
  /** Search queries the provider ran (billed per query after the free allowance). */
  queries: number;
  inputTokens: number;
  /** Output and thinking tokens of the search request. */
  outputTokens: number;
}

export interface WebSearchResult {
  summary: string;
  sources: WebSearchSource[];
  usage: WebSearchUsage;
}

/**
 * Executes a short grounded search request to retrieve factual information and verifiable sources.
 * Returns compact summary (<= 1,500 tokens) and validated source citations.
 */
export async function runWebSearch(
  query: string,
  ctx: {
    modelKey?: string;
    providerInstance?: AiProvider;
    /** For tests; defaults to now. */
    now?: Date;
  } = {}
): Promise<WebSearchResult> {
  const stream = streamAi(
    {
      modelKey: ctx.modelKey || "text-economy",
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: `${searchDateInstruction(ctx.now)}\n\nSearch query: ${query}\n\nProvide a factual, compact summary of the latest information found (under 1500 tokens). Include relevant details, dates, times, or prices.\n\n${searchReportInstruction()}`,
            },
          ],
        },
      ],
      grounding: true,
      maxOutputTokens: 1500,
      thinking: { summaries: false },
    },
    {
      providerInstance: ctx.providerInstance,
      now: ctx.now,
    }
  );

  let summary = "";
  const sources: WebSearchSource[] = [];
  const usage: WebSearchUsage = { queries: 1, inputTokens: 0, outputTokens: 0 };

  for await (const event of stream) {
    if (event.type === "text_delta") {
      summary += event.text;
    } else if (event.type === "usage") {
      usage.inputTokens = event.inputTokens;
      usage.outputTokens = event.outputTokens + (event.thoughtTokens ?? 0);
      // At least one query ran for a grounded request, even if none was reported.
      usage.queries = Math.max(1, event.searchQueries ?? 1);
    } else if (event.type === "citation") {
      const check = validateCitationUrl(event.url);
      if (check.valid && check.normalizedUrl) {
        const existing = sources.find((s) => s.url === check.normalizedUrl);
        if (existing) {
          if (event.segments?.length) {
            existing.segments = [...(existing.segments ?? []), ...event.segments];
          }
        } else {
          sources.push({
            url: check.normalizedUrl,
            title: event.title || check.hostname || undefined,
            segments: event.segments?.length ? [...event.segments] : undefined,
          });
        }
      }
    }
  }

  return {
    // Not trimmed: the sources' segment offsets point into this text.
    summary: summary.trim() ? summary : "No relevant search results found.",
    sources,
    usage,
  };
}
