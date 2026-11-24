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
  return `Today is ${formatPromptDate(now)} (UTC). Treat this as the current date: words like "current", "latest", "this season", "this year", "today" or "now" refer to it, not to the date of your training data.`;
}

/** Extra rules for the search step (the request that runs the web search). */
export function searchDateInstruction(now: Date = new Date()): string {
  return `${currentDateInstruction(now)} If the question is about current or recent events and names no year, season or date, search for the current one (the season or period that includes today). Prefer the most recent sources, and say the date of the information when it matters.`;
}
