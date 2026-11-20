/**
 * Image generation switch (text-only launch, owner decided 2026-11-20).
 *
 * Off unless `NEXT_PUBLIC_IMAGE_GENERATION_ENABLED=true`. While off:
 * - the server refuses image generations and image regenerations (403 `image_generation_disabled`);
 * - entitlements drop the image model and the `images` feature for every plan;
 * - the composer has no image mode, image starters are hidden, image responses can't be regenerated;
 * - marketing, pricing, FAQ and help copy don't mention image generation.
 *
 * The image code itself is unchanged: setting the variable to "true" (and
 * rebuilding, since NEXT_PUBLIC_ values are inlined at build time) brings it all back.
 * Turn it on only once Creem has approved the store with the Customer Credits
 * and Moderation API integration image products need (see CLAUDE.md).
 */
export function isImageGenerationEnabled(): boolean {
  return process.env.NEXT_PUBLIC_IMAGE_GENERATION_ENABLED === "true";
}

/** Plan feature message keys without the image one while image generation is off. */
export function visiblePlanFeatures(featureKeys: readonly string[]): string[] {
  return isImageGenerationEnabled()
    ? [...featureKeys]
    : featureKeys.filter((key) => !key.endsWith(".features.images"));
}
