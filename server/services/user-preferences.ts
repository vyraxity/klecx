import "server-only";
import type { ThemePreference, UserPreference } from "@/server/db/generated/client";
import { db } from "@/server/db/client";
import type { UpdatePreferencesInput } from "@/lib/schemas/user-preferences";
import type { Theme } from "@/lib/theme";

/**
 * Step 9.2: the full preferences object. No row is written until the person
 * changes something; until then (and for every field never changed) these
 * defaults apply.
 */
export interface UserPreferencesDto {
  uiLocale: string | null;
  aiLanguage: string | null;
  webSearchEnabled: boolean;
  theme: Theme;
  /** Whether the theme was chosen on the account (else the device's cookie decides). */
  themeSaved: boolean;
  enterToSend: boolean;
  reduceMotion: boolean | null;
  voiceProvider: string | null;
  voiceId: string | null;
  voiceSpeed: number;
  onboardingDismissed: boolean;
  updatedAt: Date | null;
}

const THEME_TO_DB: Record<Theme, ThemePreference> = { system: "SYSTEM", light: "LIGHT", dark: "DARK" };
const THEME_FROM_DB: Record<ThemePreference, Theme> = { SYSTEM: "system", LIGHT: "light", DARK: "dark" };

function toDto(pref: UserPreference | null): UserPreferencesDto {
  return {
    uiLocale: pref?.uiLocale ?? null,
    aiLanguage: pref?.aiLanguage ?? null,
    webSearchEnabled: pref?.webSearchEnabled ?? true,
    theme: pref?.theme ? THEME_FROM_DB[pref.theme] : "system",
    themeSaved: Boolean(pref?.theme),
    enterToSend: pref?.enterToSend ?? true,
    reduceMotion: pref?.reduceMotion ?? null,
    voiceProvider: pref?.voiceProvider ?? null,
    voiceId: pref?.voiceId ?? null,
    voiceSpeed: pref?.voiceSpeed ?? 1,
    onboardingDismissed: pref?.onboardingDismissed ?? false,
    updatedAt: pref?.updatedAt ?? null,
  };
}

export async function getUserPreferences(userId: string): Promise<UserPreferencesDto> {
  const pref = await db.userPreference.findUnique({ where: { userId } });
  return toDto(pref);
}

export async function updateUserPreferences(
  userId: string,
  input: UpdatePreferencesInput
): Promise<UserPreferencesDto> {
  const data = {
    ...(input.uiLocale !== undefined && { uiLocale: input.uiLocale }),
    ...(input.aiLanguage !== undefined && { aiLanguage: input.aiLanguage }),
    ...(input.webSearchEnabled !== undefined && { webSearchEnabled: input.webSearchEnabled }),
    ...(input.theme !== undefined && { theme: THEME_TO_DB[input.theme] }),
    ...(input.enterToSend !== undefined && { enterToSend: input.enterToSend }),
    ...(input.reduceMotion !== undefined && { reduceMotion: input.reduceMotion }),
    ...(input.onboardingDismissed !== undefined && { onboardingDismissed: input.onboardingDismissed }),
  };
  const updated = await db.userPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return toDto(updated);
}

/**
 * What the root layout needs before rendering <html>: the account's theme
 * (null when never chosen) and the reduced-motion override.
 */
export async function getDisplayPreferences(
  userId: string
): Promise<{ theme: Theme | null; reduceMotion: boolean }> {
  const pref = await db.userPreference.findUnique({
    where: { userId },
    select: { theme: true, reduceMotion: true },
  });
  return {
    theme: pref?.theme ? THEME_FROM_DB[pref.theme] : null,
    reduceMotion: pref?.reduceMotion === true,
  };
}
