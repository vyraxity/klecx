import "server-only";
import { APIError } from "better-auth/api";
import { verifyPassword } from "better-auth/crypto";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/auth";
import { Errors } from "@/server/http/errors";
import { limit } from "@/server/http/rate-limit";
import { sendEmail } from "@/server/email/send";
import { refreshUserSessionCache } from "@/server/auth/refresh-user-sessions";
import { manualEntryKey } from "@/lib/auth/two-factor";
import type { Actor } from "@/server/auth/session";
import type { TwoFactorChangedData } from "@/server/email/templates/types";

/**
 * Two-factor sign-in (after Step 10.1), Settings → Security.
 *
 * Better Auth's `twoFactor` plugin stores the encrypted TOTP secret and backup
 * codes and runs the sign-in challenge. Turning it on, making new backup codes
 * and turning it off go through here (never the plugin's endpoints from the
 * browser, which `app/api/auth/[...all]` refuses), so every change is
 * throttled, needs the password, is written to `audit_logs` and emailed.
 *
 * Two-factor needs a password: it protects email-and-password sign-in.
 * Sign-ins with Google or GitHub rely on that account's own security.
 */

export interface TwoFactorStatusDto {
  enabled: boolean;
  /** Only accounts with a password can turn it on. */
  hasPassword: boolean;
}

export interface TwoFactorSetupDto {
  /** otpauth:// URI for the QR code. */
  totpUri: string;
  /** The same secret, grouped for typing by hand. */
  manualKey: string;
  /** One-time backup codes; shown once, after the first code is confirmed. */
  backupCodes: string[];
}

async function hasPassword(userId: string): Promise<boolean> {
  const credential = await db.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true },
  });
  return Boolean(credential?.password);
}

export async function getTwoFactorStatus(userId: string): Promise<TwoFactorStatusDto> {
  const [user, withPassword] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } }),
    hasPassword(userId),
  ]);
  return { enabled: Boolean(user?.twoFactorEnabled), hasPassword: withPassword };
}

/** The password re-entry every change needs (throttled per person). */
async function checkPassword(actor: Actor, password: string): Promise<void> {
  await limit("auth:reauth", actor.userId);
  const credential = await db.account.findFirst({
    where: { userId: actor.userId, providerId: "credential" },
    select: { password: true },
  });
  if (!credential?.password) {
    throw Errors.conflict("Set a password before turning on two-factor sign-in", "password_required");
  }
  const valid = await verifyPassword({ hash: credential.password, password });
  // 403, not 401: a 401 makes route() clear the caller's auth cookies.
  if (!valid) throw Errors.forbidden("Incorrect password", "INVALID_PASSWORD");
}

/** Better Auth errors never reach the browser as-is (a 401 would sign the person out). */
function mapAuthError(err: unknown): never {
  if (err instanceof APIError) {
    const code = (err.body as { code?: string } | undefined)?.code;
    if (code === "INVALID_CODE") throw Errors.unprocessable("Invalid code", "invalid_code");
    if (code === "INVALID_PASSWORD") throw Errors.forbidden("Incorrect password", "INVALID_PASSWORD");
    if (code === "TOTP_ALREADY_ENABLED") throw Errors.conflict("Two-factor is already on", "two_factor_already_on");
    if (code === "TOTP_NOT_ENABLED" || code === "TWO_FACTOR_NOT_ENABLED") {
      throw Errors.conflict("Two-factor setup hasn't started", "two_factor_not_started");
    }
  }
  throw err;
}

async function record(userId: string, action: string, kind: TwoFactorChangedData["kind"], actorId = userId) {
  await db.auditLog.create({ data: { userId: actorId, action, ...(actorId !== userId ? { targetId: userId } : {}) } });
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (user) {
    await sendEmail("two-factor-changed", user.email, { kind, time: new Date().toUTCString() }).catch(
      () => undefined
    );
  }
}

/**
 * Step 1 of turning it on: checks the password and creates a new (unverified)
 * secret and backup codes. Nothing changes for sign-in until step 2.
 */
export async function startTwoFactorSetup(
  actor: Actor,
  password: string,
  headers: Headers
): Promise<TwoFactorSetupDto> {
  const status = await getTwoFactorStatus(actor.userId);
  if (status.enabled) throw Errors.conflict("Two-factor is already on", "two_factor_already_on");
  await checkPassword(actor, password);
  try {
    const res = await auth.api.enableTwoFactor({ body: { password }, headers });
    const totpUri = (res as { totpURI?: string }).totpURI ?? "";
    return {
      totpUri,
      manualKey: manualEntryKey(totpUri),
      backupCodes: (res as { backupCodes?: string[] }).backupCodes ?? [],
    };
  } catch (err) {
    mapAuthError(err);
  }
}

/**
 * Step 2: the first code from the app turns it on. Better Auth replaces the
 * session (new cookie in this response), as for any security change.
 */
export async function confirmTwoFactorSetup(
  actor: Actor,
  code: string,
  headers: Headers
): Promise<TwoFactorStatusDto> {
  await limit("auth:2fa", `user:${actor.userId}`);
  const status = await getTwoFactorStatus(actor.userId);
  if (status.enabled) throw Errors.conflict("Two-factor is already on", "two_factor_already_on");
  try {
    await auth.api.verifyTOTP({ body: { code }, headers });
  } catch (err) {
    mapAuthError(err);
  }
  await record(actor.userId, "TWO_FACTOR_ENABLED", "enabled");
  return { enabled: true, hasPassword: true };
}

/** New backup codes; the old ones stop working. */
export async function regenerateBackupCodes(
  actor: Actor,
  password: string,
  headers: Headers
): Promise<{ backupCodes: string[] }> {
  const status = await getTwoFactorStatus(actor.userId);
  if (!status.enabled) throw Errors.conflict("Two-factor isn't on", "two_factor_not_on");
  await checkPassword(actor, password);
  try {
    const res = await auth.api.generateBackupCodes({ body: { password }, headers });
    await record(actor.userId, "TWO_FACTOR_BACKUP_CODES_REGENERATED", "backupCodes");
    return { backupCodes: (res as { backupCodes?: string[] }).backupCodes ?? [] };
  } catch (err) {
    mapAuthError(err);
  }
}

/** Removes two-factor from an account: secret, backup codes and trusted devices. */
async function clearTwoFactor(userId: string): Promise<void> {
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } }),
    db.twoFactor.deleteMany({ where: { userId } }),
    // "Trust this device" records (Better Auth keeps them as verification values).
    db.verification.deleteMany({ where: { identifier: { startsWith: "trust-device-" }, value: userId } }),
  ]);
  await refreshUserSessionCache(userId);
}

export async function disableTwoFactor(actor: Actor, password: string): Promise<TwoFactorStatusDto> {
  const status = await getTwoFactorStatus(actor.userId);
  if (!status.enabled) throw Errors.conflict("Two-factor isn't on", "two_factor_not_on");
  await checkPassword(actor, password);
  await clearTwoFactor(actor.userId);
  await record(actor.userId, "TWO_FACTOR_DISABLED", "disabled");
  return { enabled: false, hasPassword: true };
}

/**
 * Admins only: someone who lost their authenticator app and backup codes,
 * after support has verified who they are (`ADMIN_CONSOLE.md`). Their
 * sessions stay; the email tells them two-factor was removed.
 */
export async function adminResetTwoFactor(actor: Actor, userId: string): Promise<{ ok: true; wasEnabled: boolean }> {
  if (actor.role !== "ADMIN") throw Errors.forbidden("Admin role required");
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, twoFactorEnabled: true } });
  if (!user) throw Errors.notFound("User");
  const hadRow = await db.twoFactor.count({ where: { userId } });
  if (!user.twoFactorEnabled && hadRow === 0) return { ok: true, wasEnabled: false };
  await clearTwoFactor(userId);
  await record(userId, "ADMIN_RESET_TWO_FACTOR", "resetBySupport", actor.userId);
  return { ok: true, wasEnabled: user.twoFactorEnabled };
}
