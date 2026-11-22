import { z } from "zod";
import { UI_LOCALES, AI_LANGUAGES } from "@/lib/locale";
import { THEMES } from "@/lib/theme";

/**
 * Step 9.2: what a person can change through `PATCH /api/v1/me/preferences`.
 * Voice settings (provider, voice, speed) are read-only until Step 9.4,
 * which checks them against the plan.
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
  })
  .strict();

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
