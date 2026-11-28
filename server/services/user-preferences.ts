import "server-only";
import type { DensityPreference, ThemePreference, UserPreference } from "@/server/db/generated/client";
import { db } from "@/server/db/client";
import { Errors } from "@/server/http/errors";
import { getEntitlements } from "@/server/billing/entitlements";
import { isNaturalVoice } from "@/lib/speech/voices";
import type { UpdatePreferencesInput } from "@/lib/schemas/user-preferences";
import type { Density, Theme } from "@/lib/theme";
import { isDefaultModelChoice, type DefaultModelChoice } from "@/lib/ai/default-model";

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
  density: Density;
  /** Pre-10.6 fix: the saved default model for new messages; null = Automatic. */
  defaultModelKey: DefaultModelChoice | null;
  updatedAt: Date | null;
}

const THEME_TO_DB: Record<Theme, ThemePreference> = { system: "SYSTEM", light: "LIGHT", dark: "DARK" };
const THEME_FROM_DB: Record<ThemePreference, Theme> = { SYSTEM: "system", LIGHT: "light", DARK: "dark" };
const DENSITY_TO_DB: Record<Density, DensityPreference> = { comfortable: "COMFORTABLE", compact: "COMPACT" };

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
    density: pref?.density === "COMPACT" ? "compact" : "comfortable",
    defaultModelKey: isDefaultModelChoice(pref?.defaultModelKey) ? pref.defaultModelKey : null,
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
  await assertVoiceChoiceAllowed(userId, input);
  await assertDefaultModelAllowed(userId, input);
  const data = {
    ...(input.uiLocale !== undefined && { uiLocale: input.uiLocale }),
    ...(input.aiLanguage !== undefined && { aiLanguage: input.aiLanguage }),
    ...(input.webSearchEnabled !== undefined && { webSearchEnabled: input.webSearchEnabled }),
    ...(input.theme !== undefined && { theme: THEME_TO_DB[input.theme] }),
    ...(input.enterToSend !== undefined && { enterToSend: input.enterToSend }),
    ...(input.reduceMotion !== undefined && { reduceMotion: input.reduceMotion }),
    ...(input.onboardingDismissed !== undefined && { onboardingDismissed: input.onboardingDismissed }),
    ...(input.density !== undefined && { density: DENSITY_TO_DB[input.density] }),
    ...(input.voiceProvider !== undefined && { voiceProvider: input.voiceProvider }),
    ...(input.voiceId !== undefined && { voiceId: input.voiceId }),
    ...(input.voiceSpeed !== undefined && { voiceSpeed: input.voiceSpeed }),
    ...(input.defaultModelKey !== undefined && { defaultModelKey: input.defaultModelKey }),
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
 * (null when never chosen), the reduced-motion override and the density.
 */
export async function getDisplayPreferences(
  userId: string
): Promise<{ theme: Theme | null; reduceMotion: boolean; density: Density }> {
  const pref = await db.userPreference.findUnique({
    where: { userId },
    select: { theme: true, reduceMotion: true, density: true },
  });
  return {
    theme: pref?.theme ? THEME_FROM_DB[pref.theme] : null,
    reduceMotion: pref?.reduceMotion === true,
    density: pref?.density === "COMPACT" ? "compact" : "comfortable",
  };
}

/**
 * Step 9.4: natural voices need a plan that includes them, and a natural
 * voice id must be one of the list. Browser voice names are free text (they
 * differ per device) and are never sent to a provider.
 */
async function assertVoiceChoiceAllowed(userId: string, input: UpdatePreferencesInput) {
  if (input.voiceProvider === undefined && input.voiceId === undefined) return;
  const current = await db.userPreference.findUnique({ where: { userId }, select: { voiceProvider: true } });
  const provider = input.voiceProvider !== undefined ? input.voiceProvider : current?.voiceProvider ?? null;
  if (input.voiceProvider === "natural") {
    const entitlements = await getEntitlements(userId);
    if (!entitlements.features.naturalVoices) {
      throw Errors.forbidden("Natural voices aren't included in your plan", "plan_upgrade_required");
    }
  }
  if (provider === "natural" && input.voiceId && !isNaturalVoice(input.voiceId)) {
    throw Errors.unprocessable("Unknown voice", "unknown_voice");
  }
}

/**
 * Pre-10.6 fix: a default model can only be one the person's own plan offers
 * (Automatic is always allowed). In someone else's workspace the owner's plan
 * still decides what runs (`resolveDefaultTextModel()`).
 */
async function assertDefaultModelAllowed(userId: string, input: UpdatePreferencesInput) {
  if (!input.defaultModelKey) return;
  const entitlements = await getEntitlements(userId);
  if (!(entitlements.models as readonly string[]).includes(input.defaultModelKey)) {
    throw Errors.forbidden("This model isn't included in your plan", "model_not_in_plan");
  }
}

/** The person's saved default model (null = Automatic), for the generation service. */
export async function getDefaultModelPreference(userId: string): Promise<DefaultModelChoice | null> {
  const pref = await db.userPreference.findUnique({
    where: { userId },
    select: { defaultModelKey: true },
  });
  return isDefaultModelChoice(pref?.defaultModelKey) ? pref.defaultModelKey : null;
}
