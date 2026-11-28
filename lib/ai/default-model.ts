import type { ModelKey } from "@/lib/ai/model-catalog";

/**
 * Pre-10.6 fix (owner, 2026-11-27): the model a new message uses unless the
 * person picks another one in the composer.
 *
 * `UserPreference.defaultModelKey` is the person's choice in Settings →
 * Language & AI; `null` is **Automatic**: Standard Reasoning whenever the
 * plan that pays for the message (the workspace owner's) includes it, else
 * Fast & Efficient. A saved choice the paying plan doesn't include falls back
 * the same way. Regenerate doesn't use this (it keeps the version's model).
 */
export const DEFAULT_MODEL_CHOICES = ["text-economy", "text-standard"] as const satisfies readonly ModelKey[];
export type DefaultModelChoice = (typeof DEFAULT_MODEL_CHOICES)[number];

export function isDefaultModelChoice(value: unknown): value is DefaultModelChoice {
  return (DEFAULT_MODEL_CHOICES as readonly unknown[]).includes(value);
}

/** The best text model a plan includes: Standard Reasoning, else Fast & Efficient. */
export function bestTextModel(allowedModels: readonly string[]): DefaultModelChoice {
  return allowedModels.includes("text-standard") ? "text-standard" : "text-economy";
}

/**
 * @param preference the person's saved default (null = Automatic)
 * @param allowedModels the models of the plan that pays (the workspace owner's)
 */
export function resolveDefaultTextModel(
  preference: string | null | undefined,
  allowedModels: readonly string[]
): DefaultModelChoice {
  if (isDefaultModelChoice(preference) && allowedModels.includes(preference)) {
    return preference;
  }
  return bestTextModel(allowedModels);
}
