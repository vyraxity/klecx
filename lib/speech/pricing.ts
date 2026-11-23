import { CREDIT_USD } from "@/lib/ai/model-catalog";

/**
 * Step 9.4: natural-voice read-aloud is charged like answers (owner decided
 * 2026-11-22): from the provider's price, converted at CREDIT_USD, on the
 * real length of the audio. Price of the read-aloud model (docs read
 * 2026-11-22): $0.0015 per 10 s of audio until 31 Dec 2026, $0.003 from
 * 1 Jan 2027 — the switch is built in so it can't be forgotten. Text input is
 * $0.50 per million tokens until then, $1.00 after (negligible, still counted).
 */
const PRICE_CHANGE = Date.UTC(2027, 0, 1);

export function speechPrices(now: Date = new Date()) {
  const later = now.getTime() >= PRICE_CHANGE;
  return {
    usdPerAudioSecond: later ? 0.0003 : 0.00015,
    usdPerMillionInputTokens: later ? 1 : 0.5,
  };
}

/** About 4 characters per text token. */
const CHARS_PER_TOKEN = 4;
/** Speech runs at about 15 characters per second; used to size reservations. */
export const CHARS_PER_AUDIO_SECOND = 15;

/** Credits for one synthesized segment, at least 1. */
export function speechCreditsFor(audioSeconds: number, inputChars: number, now: Date = new Date()): number {
  const p = speechPrices(now);
  const usd =
    audioSeconds * p.usdPerAudioSecond +
    (Math.ceil(inputChars / CHARS_PER_TOKEN) * p.usdPerMillionInputTokens) / 1_000_000;
  return Math.max(1, Math.ceil(usd / CREDIT_USD));
}

/** The estimated audio length of a text (to reserve credits and check the daily limit). */
export function estimateAudioSeconds(chars: number): number {
  return Math.max(1, Math.ceil(chars / CHARS_PER_AUDIO_SECOND));
}
