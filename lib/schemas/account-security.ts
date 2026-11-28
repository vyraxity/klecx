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

/**
 * Pre-10.6 fix: an account without a password (Google/GitHub sign-in) adds
 * one in Settings → Security with a 6-digit code emailed to it.
 */
export const SET_PASSWORD_CODE_MINUTES = 10;
export const SET_PASSWORD_MAX_ATTEMPTS = 5;
export const setPasswordConfirmSchema = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();
export type SetPasswordConfirmInput = z.infer<typeof setPasswordConfirmSchema>;

export const unlinkAccountSchema = z
  .object({ password: z.string().max(PASSWORD_MAX_LENGTH).optional() })
  .optional();

export const changeEmailSchema = z.object({
  newEmail: z.string().trim().email().max(254),
});
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;

/** Two-factor sign-in (after Step 10.1): Settings → Security. */
export const twoFactorPasswordSchema = z
  .object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) })
  .strict();

export const twoFactorCodeSchema = z
  .object({ code: z.string().trim().regex(/^\d{6}$/) })
  .strict();
