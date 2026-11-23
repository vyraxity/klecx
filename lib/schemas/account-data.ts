import { z } from "zod";

/** Step 9.5: Settings → Your data. */
export const deleteAccountSchema = z
  .object({
    /** The account's email address, typed as confirmation. */
    confirmEmail: z.string().trim().min(3).max(320),
    /** Needed when the session isn't fresh (signed in more than 15 minutes ago). */
    password: z.string().max(128).optional(),
  })
  .strict();

export const restoreAccountSchema = z.object({ token: z.string().trim().min(10).max(200) }).strict();

export const adminPurgeSchema = z.object({ force: z.boolean().optional() }).strict();
