/**
 * Feature switches (Step 10.6): risky features that can be paused without a code change.
 *
 * Two layers, both able only to turn a feature OFF:
 * - `DISABLED_FEATURES` (env, comma-separated keys): off for that deployment until the
 *   variable changes (Vercel applies it on the next deploy or redeploy);
 * - an admin's runtime pause (`feature_flags` table, `PUT /api/v1/admin/features/:key`):
 *   takes effect within `FEATURE_FLAG_CACHE_MS` on every server instance, no redeploy.
 * A feature is on only when neither layer turns it off. Nothing here can turn on a
 * feature the code keeps off (image generation has its own build-time switch).
 *
 * This file is isomorphic (keys and the browser-facing shape); the server side is `server/flags.ts`.
 */
export const FEATURE_KEYS = [
  /** The kill switch: every new AI call (answers, Asks, the question queue, reviews,
   *  voice input, natural-voice read-aloud and voice previews). */
  "ai",
  /** The web-search tool: answers are written without searching. */
  "webSearch",
  /** Voice input (transcription) in the composer. */
  "voiceInput",
  /** Natural voices for read-aloud: the player uses the browser's voice. */
  "naturalVoices",
  /** "Ask Klecx to review" on responses and documents. */
  "documentReview",
  /** New invitations (and resends) and new share links; existing members and links keep working. */
  "collaboration",
  /** New sign-ups (email and Google/GitHub); existing accounts still sign in. */
  "signups",
  /** New checkouts and plan upgrades; webhooks, cancel, resume and the portal keep working. */
  "checkout",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type FeatureStates = Record<FeatureKey, boolean>;

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value);
}

/** How long a server instance trusts its copy of the runtime pauses. */
export const FEATURE_FLAG_CACHE_MS = 10_000;

/** Every feature on: the browser's default until `GET /api/v1/features` answers. */
export const ALL_FEATURES_ON: FeatureStates = Object.fromEntries(
  FEATURE_KEYS.map((key) => [key, true])
) as FeatureStates;

/** The error codes a paused feature answers with (503). */
export const AI_PAUSED_CODE = "ai_paused";
export const FEATURE_PAUSED_CODE = "feature_paused";
