import "server-only";
import { log, errInfo } from "@/server/log";
import { db } from "@/server/db/client";
import { Errors } from "@/server/http/errors";
import type { Actor } from "@/server/auth/session";
import { refreshUserSessionCache } from "@/server/auth/refresh-user-sessions";

/**
 * Abuse operations (Step 8.6, Creem account-review readiness): an admin can
 * **suspend** an account and **freeze** its credits.
 *
 * - Suspended: the person can't sign in (`session.create.before` refuses with
 *   `ACCOUNT_SUSPENDED`), every session is revoked at once, and `getActor`
 *   treats a suspended user as signed out. Nothing is deleted.
 * - Frozen credits: nothing may spend the account's credits (`reserve()`
 *   throws 403 `credits_frozen`), in the person's own workspaces and as the
 *   owner who pays for members. Suspending can freeze the credits too.
 *
 * Only `role = ADMIN` may do this (others get 403), never on another admin
 * or on oneself. Every change writes an `AuditLog` entry. The admin console
 * (separate codebase, `ADMIN_CONSOLE.md`) calls the `/api/v1/admin/users/:id/*` routes.
 */

function requireAdmin(actor: Actor) {
  if (actor.role !== "ADMIN") throw Errors.forbidden("Admin role required");
}

async function loadTarget(actor: Actor, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, suspendedAt: true },
  });
  if (!user) throw Errors.notFound("User");
  if (user.id === actor.userId || user.role === "ADMIN") {
    throw Errors.forbidden("Admins can't be suspended or frozen here", "admin_target");
  }
  return user;
}

const cleanReason = (reason: string) => reason.trim().slice(0, 500);

/** Revokes every session of `userId` (signs them out everywhere, including the session cache). */
export async function revokeAllSessions(userId: string): Promise<void> {
  try {
    const { auth } = await import("@/server/auth/auth");
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUserSessions(userId);
  } catch (err) {
    log.error({ err: errInfo(err) }, "[moderation] session revoke failed");
  }
  // Whatever the cache did, no session row may survive.
  await db.session.deleteMany({ where: { userId } });
}

export async function suspendUser(
  actor: Actor,
  userId: string,
  input: { reason: string; freezeCredits?: boolean }
): Promise<{ suspendedAt: string; creditsFrozen: boolean }> {
  requireAdmin(actor);
  const target = await loadTarget(actor, userId);
  const now = target.suspendedAt ?? new Date();
  const reason = cleanReason(input.reason);

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { suspendedAt: now, suspendedReason: reason } });
    if (input.freezeCredits) {
      await tx.creditAccount.updateMany({
        where: { userId, frozenAt: null },
        data: { frozenAt: now, frozenReason: reason },
      });
    }
    await tx.auditLog.create({
      data: {
        userId: actor.userId,
        action: "ADMIN_SUSPEND_USER",
        targetId: userId,
        metadata: { reason, freezeCredits: Boolean(input.freezeCredits) },
      },
    });
  });
  await revokeAllSessions(userId);
  return { suspendedAt: now.toISOString(), creditsFrozen: Boolean(input.freezeCredits) };
}

export async function unsuspendUser(actor: Actor, userId: string): Promise<{ ok: true }> {
  requireAdmin(actor);
  await loadTarget(actor, userId);
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { suspendedAt: null, suspendedReason: null } }),
    db.auditLog.create({ data: { userId: actor.userId, action: "ADMIN_UNSUSPEND_USER", targetId: userId } }),
  ]);
  await refreshUserSessionCache(userId);
  return { ok: true };
}

export async function freezeCredits(actor: Actor, userId: string, input: { reason: string }): Promise<{ ok: true }> {
  requireAdmin(actor);
  await loadTarget(actor, userId);
  const reason = cleanReason(input.reason);
  const account = await db.creditAccount.findUnique({ where: { userId }, select: { id: true } });
  if (!account) throw Errors.notFound("CreditAccount");
  await db.$transaction([
    db.creditAccount.update({ where: { userId }, data: { frozenAt: new Date(), frozenReason: reason } }),
    db.auditLog.create({ data: { userId: actor.userId, action: "ADMIN_FREEZE_CREDITS", targetId: userId, metadata: { reason } } }),
  ]);
  return { ok: true };
}

export async function unfreezeCredits(actor: Actor, userId: string): Promise<{ ok: true }> {
  requireAdmin(actor);
  await loadTarget(actor, userId);
  await db.$transaction([
    db.creditAccount.updateMany({ where: { userId }, data: { frozenAt: null, frozenReason: null } }),
    db.auditLog.create({ data: { userId: actor.userId, action: "ADMIN_UNFREEZE_CREDITS", targetId: userId } }),
  ]);
  return { ok: true };
}

/** Whether `userId` is suspended (sign-in check). */
export async function isUserSuspended(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
  return Boolean(user?.suspendedAt);
}

/** Why a sign-in must be refused: suspended (Step 8.6) or deleted (Step 9.5), else null. */
export async function getSignInBlock(userId: string): Promise<"suspended" | "deleted" | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { suspendedAt: true, deletedAt: true } });
  if (user?.suspendedAt) return "suspended";
  if (user?.deletedAt) return "deleted";
  return null;
}
