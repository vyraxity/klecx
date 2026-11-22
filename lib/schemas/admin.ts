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
