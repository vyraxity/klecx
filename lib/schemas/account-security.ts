import { z } from "zod";

/** Step 9.1: social sign-in providers that can be connected or disconnected in Settings → Security. */
export const SOCIAL_PROVIDERS = ["google", "github"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** `credential` = email + password. */
export type SignInMethod = SocialProvider | "credential";

export const socialProviderSchema = z.enum(SOCIAL_PROVIDERS);

/** Same bounds as Better Auth's `emailAndPassword` (server/auth/auth.ts). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const unlinkAccountSchema = z
  .object({ password: z.string().max(PASSWORD_MAX_LENGTH).optional() })
  .optional();

export const changeEmailSchema = z.object({
  newEmail: z.string().trim().email().max(254),
});
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;
