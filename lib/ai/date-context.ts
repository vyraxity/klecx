/**
 * Today's date for AI prompts (fix before Step 10.3). Without it the model
 * assumes its training-era "now" and searches for stale seasons and events
 * (owner's report, 2026-11-21: Premier League matchday 11 answered with
 * 2024/25 results). Always UTC and in English: it's an instruction to the
 * model, not text shown to people.
 */
export function formatPromptDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(now);
}

/** The line added to every AI request's instructions. */
export function currentDateInstruction(now: Date = new Date()): string {
  return `Today is ${formatPromptDate(now)} (UTC). This date comes from the system clock and is correct, even though it is later than your training data: do not question it, call it a test or a placeholder, or mention that it seems unusual. Treat it as the current date: words like "current", "latest", "next", "upcoming", "this season", "this year", "today" or "now" refer to it, not to the date of your training data.`;
}

/** Extra rules for the search step (the request that runs the web search). */
export function searchDateInstruction(now: Date = new Date()): string {
  return `${currentDateInstruction(now)} If the question is about current or recent events and names no year, season or date, search for the current one (the season or period that includes today). Turn relative words ("next", "upcoming", "this week", "this weekend") into actual dates before searching, and include those dates in the search. Prefer the most recent sources, and say the date of the information when it matters.`;
}

/**
 * How the search step must report what it found (fix after the owner's
 * report of 2026-11-24: fixtures with wrong days and kick-off times). The
 * answering model only sees this summary, never the pages, so it must keep
 * the facts exactly as the sources state them.
 */
export function searchReportInstruction(): string {
  return [
    "Report what the sources say, precisely:",
    "- Copy dates, weekdays, times and numbers exactly as the source gives them. Always give a time with its time zone as the source states it (e.g. 20:00 GMT, 3pm ET); if the source gives none, say the time zone is not stated. Never convert or guess a time, day or date.",
    "- When the question asks for a list (fixtures, schedules, results, prices, rankings), give the complete list from the source, one item per line, not a selection.",
    "- If sources disagree on a fact, give both versions and name each source.",
    "- If something isn't confirmed yet (to be decided, provisional), say so.",
    "- Start directly with the facts: no introduction such as \"As of today\", and don't repeat today's date.",
  ].join("\n");
}
