import { z } from "zod";

/** Step 8.6: admin abuse operations (`/api/v1/admin/users/:id/*`). */
export const suspendUserSchema = z
  .object({
    /** Internal note (never shown to the person). */
    reason: z.string().trim().min(3).max(500),
    /** Also freeze the account's credits. */
    freezeCredits: z.boolean().optional(),
  })
  .strict();

export const freezeCreditsSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** Step 10.6: pause or resume a feature switch (`PUT /api/v1/admin/features/:key`). */
export const setFeatureFlagSchema = z
  .object({
    enabled: z.boolean(),
    /** Internal note: why it was paused (never shown to users). */
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
