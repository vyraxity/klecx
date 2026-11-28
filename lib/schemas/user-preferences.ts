import { z } from "zod";
import { UI_LOCALES, AI_LANGUAGES } from "@/lib/locale";
import { DENSITIES, THEMES } from "@/lib/theme";
import { MAX_VOICE_SPEED, MIN_VOICE_SPEED, VOICE_PROVIDERS } from "@/lib/speech/voices";
import { DEFAULT_MODEL_CHOICES } from "@/lib/ai/default-model";

/**
 * Step 9.2: what a person can change through `PATCH /api/v1/me/preferences`.
 * Voice settings (Step 9.4) are checked against the plan on the server.
 */
export const updatePreferencesSchema = z
  .object({
    uiLocale: z.enum(UI_LOCALES).nullable().optional(),
    aiLanguage: z.enum(AI_LANGUAGES).nullable().optional(),
    webSearchEnabled: z.boolean().optional(),
    theme: z.enum(THEMES).optional(),
    enterToSend: z.boolean().optional(),
    /** true = always reduce motion; null = follow the device. */
    reduceMotion: z.literal(true).nullable().optional(),
    onboardingDismissed: z.boolean().optional(),
    density: z.enum(DENSITIES).optional(),
    voiceProvider: z.enum(VOICE_PROVIDERS).nullable().optional(),
    /** A natural voice id, or a browser voice name (device-specific). */
    voiceId: z.string().trim().min(1).max(200).nullable().optional(),
    voiceSpeed: z.number().min(MIN_VOICE_SPEED).max(MAX_VOICE_SPEED).optional(),
    /** Pre-10.6 fix: the default model for new messages; null = Automatic. Checked against the plan. */
    defaultModelKey: z.enum(DEFAULT_MODEL_CHOICES).nullable().optional(),
  })
  .strict();

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
