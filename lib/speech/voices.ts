/**
 * Step 9.4: read-aloud voices.
 *
 * Natural voices are the text-to-speech model's prebuilt voices. People see
 * them as "Voice 1 · Bright" and so on (rule 6: no provider names); `id` is
 * what the model expects and what `UserPreference.voiceId` stores. The model
 * speaks the language of the text, so every voice works in every language.
 */
export const VOICE_PROVIDERS = ["natural", "browser"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const VOICE_STYLES = [
  "bright", "upbeat", "informative", "firm", "excitable", "youthful", "breezy", "easyGoing",
  "breathy", "clear", "smooth", "gravelly", "soft", "even", "mature", "forward", "friendly",
  "casual", "gentle", "lively", "knowledgeable", "warm",
] as const;
export type VoiceStyle = (typeof VOICE_STYLES)[number];

export interface NaturalVoice {
  id: string;
  style: VoiceStyle;
}

export const NATURAL_VOICES: readonly NaturalVoice[] = [
  { id: "Zephyr", style: "bright" },
  { id: "Puck", style: "upbeat" },
  { id: "Charon", style: "informative" },
  { id: "Kore", style: "firm" },
  { id: "Fenrir", style: "excitable" },
  { id: "Leda", style: "youthful" },
  { id: "Orus", style: "firm" },
  { id: "Aoede", style: "breezy" },
  { id: "Callirrhoe", style: "easyGoing" },
  { id: "Autonoe", style: "bright" },
  { id: "Enceladus", style: "breathy" },
  { id: "Iapetus", style: "clear" },
  { id: "Umbriel", style: "easyGoing" },
  { id: "Algieba", style: "smooth" },
  { id: "Despina", style: "smooth" },
  { id: "Erinome", style: "clear" },
  { id: "Algenib", style: "gravelly" },
  { id: "Rasalgethi", style: "informative" },
  { id: "Laomedeia", style: "upbeat" },
  { id: "Achernar", style: "soft" },
  { id: "Alnilam", style: "firm" },
  { id: "Schedar", style: "even" },
  { id: "Gacrux", style: "mature" },
  { id: "Pulcherrima", style: "forward" },
  { id: "Achird", style: "friendly" },
  { id: "Zubenelgenubi", style: "casual" },
  { id: "Vindemiatrix", style: "gentle" },
  { id: "Sadachbia", style: "lively" },
  { id: "Sadaltager", style: "knowledgeable" },
  { id: "Sulafat", style: "warm" },
];

export const DEFAULT_NATURAL_VOICE = "Achird";

export function isNaturalVoice(id: string | null | undefined): boolean {
  return Boolean(id && NATURAL_VOICES.some((v) => v.id === id));
}

/** 1-based number shown to people ("Voice 7"). */
export function naturalVoiceNumber(id: string): number {
  return NATURAL_VOICES.findIndex((v) => v.id === id) + 1;
}

export const MIN_VOICE_SPEED = 0.75;
export const MAX_VOICE_SPEED = 2;
