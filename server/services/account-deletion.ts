import "server-only";
import { log, errInfo } from "@/server/log";

import { createHash, randomBytes } from "node:crypto";
import { db } from "@/server/db/client";
import { ApiError, Errors } from "@/server/http/errors";
import type { Actor } from "@/server/auth/session";
import { verifySensitiveActionAuth } from "@/server/services/session";
import { revokeAllSessions } from "@/server/services/account-moderation";
import { cancelSubscriptionForAccountDeletion } from "@/server/services/billing";
import { notify } from "@/server/services/notify";
import { sendEmail } from "@/server/email/send";
import { getSiteConfig } from "@/server/config/site";
import { getStorageProvider, type StorageResourceType } from "@/server/storage";

/**
 * Step 9.5: account deletion (owner's decisions, 2026-11-23).
 *
 * 1. **Request** (`requestAccountDeletion`): a fresh sign-in (or the password)
 *    and the account's email typed as confirmation. Refused while the person
 *    owns a workspace or project that other people are members of: they
 *    transfer it (and the recipient accepts) or delete it first
 *    (`getDeletionOverview().blockers`). Then, in order: a renewing
 *    subscription is cancelled **at the end of the paid period** (no further
 *    charges; refunds follow the refund policy), pending ownership transfers
 *    are cancelled / declined, pending invitations revoked, the person's
 *    memberships in other people's workspaces and projects suspended
 *    (`suspendedReason = "account_deleted"`), `User.deletedAt` set (sign-in
 *    refused with `ACCOUNT_DELETED`, share links of their workspaces and the
 *    ones they created stop working), their Klecx notes soft-deleted, every
 *    session revoked, and an email sent with a link that restores the account.
 * 2. **Restore** (`restoreAccount`): the emailed link works for
 *    `ACCOUNT_DELETION_GRACE_DAYS` (30). It undoes step 1 except the
 *    subscription (it can be resumed in Plan & billing while the period
 *    runs), the transfers and the invitations.
 * 3. **Erase** (`purgeDeletedAccount`), after the 30 days: the person's own
 *    workspaces and projects (with everything in them), their files, private
 *    Ask threads in other people's workspaces, notes, notifications,
 *    preferences, sign-in methods, sessions, memberships, share links,
 *    exports and support requests are deleted; the `users` row is kept but
 *    anonymized ("Deleted user", an `.invalid` address). Credit, billing and
 *    consent records are kept (accounting and disputes). What they wrote in
 *    other people's workspaces stays, shown as "Deleted user". Run daily by
 *    the Step 10.3 job (`purgeDueAccounts`); idempotent and resumable.
 */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DELETED_MEMBERSHIP_REASON = "account_deleted";
export const DELETED_USER_NAME = "Deleted user";

export function deletedUserEmail(userId: string): string {
  return `deleted+${userId}@deleted.invalid`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface DeletionBlocker {
  type: "workspace" | "project";
  id: string;
  name: string;
  /** Other people with access (members, owner excluded). */
  memberCount: number;
  /** A transfer is waiting for the recipient to accept. */
  pendingTransfer: { id: string; toUserName: string; expiresAt: string } | null;
}

export interface DeletionOverview {
  email: string;
  hasPassword: boolean;
  graceDays: number;
  blockers: DeletionBlocker[];
  /** A renewing paid subscription that deletion cancels at the period end. */
  subscription: { plan: string; periodEnd: string | null } | null;
}

/**
 * Owned workspaces and projects (not deleted) that other people are members of:
 * each must be transferred (and accepted) or deleted before the account can go.
 */
async function findBlockers(userId: string): Promise<DeletionBlocker[]> {
  const now = new Date();
  const transferSelect = {
    where: { fromUserId: userId, status: "PENDING" as const, expiresAt: { gt: now } },
    select: { id: true, expiresAt: true, toUser: { select: { name: true, email: true } } },
    take: 1,
  };
  const [workspaces, projects] = await Promise.all([
    db.workspace.findMany({
      where: { ownerId: userId, deletedAt: null, members: { some: { userId: { not: userId } } } },
      select: {
        id: true,
        title: true,
        _count: { select: { members: { where: { userId: { not: userId } } } } },
        ownershipTransfers: transferSelect,
      },
      orderBy: { createdAt: "asc" },
    }),
    db.project.findMany({
      where: { ownerId: userId, deletedAt: null, members: { some: { userId: { not: userId } } } },
      select: {
        id: true,
        name: true,
        _count: { select: { members: { where: { userId: { not: userId } } } } },
        ownershipTransfers: transferSelect,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const transfer = (t: (typeof workspaces)[number]["ownershipTransfers"]) => {
    const first = t[0];
    return first
      ? { id: first.id, toUserName: first.toUser.name || first.toUser.email, expiresAt: first.expiresAt.toISOString() }
      : null;
  };
  return [
    ...projects.map((p) => ({
      type: "project" as const,
      id: p.id,
      name: p.name,
      memberCount: p._count.members,
      pendingTransfer: transfer(p.ownershipTransfers),
    })),
    ...workspaces.map((w) => ({
      type: "workspace" as const,
      id: w.id,
      name: w.title,
      memberCount: w._count.members,
      pendingTransfer: transfer(w.ownershipTransfers),
    })),
  ];
}

/** What Settings → Your data shows before deleting. */
export async function getDeletionOverview(userId: string): Promise<DeletionOverview> {
  const [user, credential, sub, blockers] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    db.account.findFirst({ where: { userId, providerId: "credential" }, select: { password: true } }),
    db.subscription.findUnique({
      where: { userId },
      select: { plan: true, status: true, cancelAtPeriodEnd: true, currentPeriodEnd: true, providerSubscriptionId: true },
    }),
    findBlockers(userId),
  ]);
  const renewing =
    sub?.providerSubscriptionId &&
    ["ACTIVE", "TRIALING", "PAST_DUE", "PAUSED"].includes(sub.status) &&
    !sub.cancelAtPeriodEnd;
  return {
    email: user.email,
    hasPassword: Boolean(credential?.password),
    graceDays: ACCOUNT_DELETION_GRACE_DAYS,
    blockers,
    subscription: renewing ? { plan: sub!.plan, periodEnd: sub!.currentPeriodEnd?.toISOString() ?? null } : null,
  };
}

async function emailLocale(userId: string): Promise<string | undefined> {
  const pref = await db.userPreference.findUnique({ where: { userId }, select: { uiLocale: true } });
  return pref?.uiLocale ?? undefined;
}

/** Step 1: delete the account (sign-in blocked at once, erased after the grace period). */
export async function requestAccountDeletion(
  actor: Actor,
  input: { confirmEmail: string; password?: string },
  requestId: string
): Promise<{ purgeAfter: string }> {
  await verifySensitiveActionAuth(actor, input.password);

  const user = await db.user.findUnique({
    where: { id: actor.userId },
    select: { id: true, name: true, email: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw Errors.notFound("User");
  if (input.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(422, "confirmation_mismatch", "Type your account's email address to confirm");
  }

  const blockers = await findBlockers(user.id);
  if (blockers.length > 0) {
    throw new ApiError(409, "deletion_blocked", "Transfer or delete the workspaces and projects you share first", {
      blockers,
    });
  }

  // No further charges. A provider error stops here, before anything changed.
  await cancelSubscriptionForAccountDeletion(user.id, requestId);

  const now = new Date();
  const purgeAfter = new Date(now.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
  const token = randomBytes(32).toString("base64url");

  const declined = await db.$transaction(async (tx) => {
    // Pending ownership transfers: the ones sent are cancelled, the ones received declined.
    await tx.ownershipTransfer.updateMany({
      where: { fromUserId: user.id, status: "PENDING" },
      data: { status: "CANCELLED", respondedAt: now },
    });
    const received = await tx.ownershipTransfer.findMany({
      where: { toUserId: user.id, status: "PENDING", expiresAt: { gt: now } },
      select: {
        id: true,
        fromUserId: true,
        workspaceId: true,
        projectId: true,
        workspace: { select: { title: true } },
        project: { select: { name: true } },
      },
    });
    await tx.ownershipTransfer.updateMany({
      where: { toUserId: user.id, status: "PENDING" },
      data: { status: "DECLINED", respondedAt: now },
    });
    // Invitations they sent can no longer be accepted.
    await tx.invitation.updateMany({
      where: { invitedById: user.id, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    // Their access to other people's workspaces and projects is paused (restored with the account).
    const suspend = { suspendedAt: now, suspendedReason: DELETED_MEMBERSHIP_REASON };
    await tx.workspaceMember.updateMany({ where: { userId: user.id, suspendedAt: null }, data: suspend });
    await tx.projectMember.updateMany({ where: { userId: user.id, suspendedAt: null }, data: suspend });

    await tx.user.update({ where: { id: user.id }, data: { deletedAt: now } });
    await tx.workspaceNote.updateMany({ where: { createdById: user.id, deletedAt: null }, data: { deletedAt: now } });
    await tx.accountDeletion.upsert({
      where: { userId: user.id },
      create: { userId: user.id, requestedAt: now, purgeAfter, restoreTokenHash: hashToken(token) },
      update: { requestedAt: now, purgeAfter, restoreTokenHash: hashToken(token), purgedAt: null },
    });
    await tx.auditLog.create({
      data: { userId: user.id, action: "ACCOUNT_DELETION_REQUESTED", metadata: { purgeAfter: purgeAfter.toISOString() } },
    });
    return received;
  });

  await revokeAllSessions(user.id);

  for (const t of declined) {
    await notify(t.fromUserId, "OWNERSHIP_TRANSFER_DECLINED", {
      transferId: t.id,
      toUserId: user.id,
      toUserName: user.name || user.email,
      resourceName: t.workspace?.title ?? t.project?.name ?? "",
      resourceType: t.workspaceId ? "workspace" : "project",
      href: t.workspaceId ? `/workspaces/${t.workspaceId}` : `/projects/${t.projectId}`,
    }).catch(() => undefined);
  }

  const restoreUrl = `${getSiteConfig().appUrl.replace(/\/$/, "")}/account/restore?token=${encodeURIComponent(token)}`;
  await sendEmail(
    "account-deletion-scheduled",
    user.email,
    { purgeAfter: purgeAfter.toISOString(), restoreUrl },
    { locale: await emailLocale(user.id) }
  ).catch(() => undefined);

  return { purgeAfter: purgeAfter.toISOString() };
}

/** Step 2: the emailed link restores the account until the erase date. */
export async function restoreAccount(token: string): Promise<{ restored: true }> {
  const trimmed = token.trim();
  const deletion = trimmed
    ? await db.accountDeletion.findUnique({
        where: { restoreTokenHash: hashToken(trimmed) },
        select: { id: true, userId: true, purgeAfter: true, purgedAt: true, user: { select: { email: true, deletedAt: true } } },
      })
    : null;
  if (!deletion || deletion.purgedAt || deletion.purgeAfter <= new Date() || !deletion.user.deletedAt) {
    throw new ApiError(410, "restore_link_invalid", "This restore link has expired or was already used");
  }
  const deletedAt = deletion.user.deletedAt;
  const userId = deletion.userId;

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { deletedAt: null } });
    // Notes deleted with the account (same timestamp) come back; ones deleted earlier stay deleted.
    await tx.workspaceNote.updateMany({ where: { createdById: userId, deletedAt }, data: { deletedAt: null } });
    const unsuspend = { suspendedAt: null, suspendedReason: null };
    const where = { userId, suspendedReason: DELETED_MEMBERSHIP_REASON };
    await tx.workspaceMember.updateMany({ where, data: unsuspend });
    await tx.projectMember.updateMany({ where, data: unsuspend });
    await tx.accountDeletion.delete({ where: { id: deletion.id } });
    await tx.auditLog.create({ data: { userId, action: "ACCOUNT_DELETION_CANCELLED" } });
  });

  await sendEmail("account-restored", deletion.user.email, {}, { locale: await emailLocale(userId) }).catch(
    () => undefined
  );
  return { restored: true };
}

async function deleteStored(
  items: { providerId: string; resourceType: string }[],
  onDeleted: (providerId: string) => Promise<unknown>
) {
  const storage = getStorageProvider();
  for (const item of items) {
    // A failure stops the purge; the next run carries on (rows already removed stay removed).
    await storage.delete(item.providerId, { resourceType: item.resourceType as StorageResourceType });
    await onDeleted(item.providerId);
  }
}

/**
 * Step 3: erase a deleted account once its grace period is over. Idempotent
 * and resumable: each file is deleted before its row, and the account is
 * marked purged only at the end. `force` skips the date check (tests, or an
 * admin acting on a verified erasure request).
 */
export async function purgeDeletedAccount(
  userId: string,
  opts: { now?: Date; force?: boolean } = {}
): Promise<{ purged: boolean }> {
  const now = opts.now ?? new Date();
  const deletion = await db.accountDeletion.findUnique({
    where: { userId },
    select: { id: true, purgeAfter: true, purgedAt: true, user: { select: { email: true, deletedAt: true } } },
  });
  if (!deletion || !deletion.user.deletedAt) throw Errors.notFound("Account deletion");
  if (deletion.purgedAt) return { purged: false };
  if (!opts.force && deletion.purgeAfter > now) {
    throw Errors.conflict("The account's grace period hasn't ended", "purge_not_due");
  }
  const email = deletion.user.email;

  // Files: everything in the person's own workspaces (whoever uploaded it), and
  // their files outside any workspace (avatar, unfinished uploads). Files they
  // added to other people's workspaces belong to those conversations and stay.
  const attachments = await db.attachment.findMany({
    where: { OR: [{ workspace: { ownerId: userId } }, { ownerId: userId, workspaceId: null }] },
    select: { id: true, providerId: true, resourceType: true },
  });
  await db.user.update({ where: { id: userId }, data: { avatarAttachmentId: null } });
  await deleteStored(attachments, (providerId) =>
    db.attachment.deleteMany({ where: { providerId, id: { in: attachments.map((a) => a.id) } } })
  );

  // Support requests and their screenshots.
  const tickets = await db.supportTicket.findMany({
    where: { OR: [{ userId }, { email: { equals: email, mode: "insensitive" } }] },
    select: { id: true, attachments: { select: { providerId: true } } },
  });
  await deleteStored(
    tickets.flatMap((t) => t.attachments.map((a) => ({ providerId: a.providerId, resourceType: "image" }))),
    (providerId) => db.supportAttachment.deleteMany({ where: { providerId } })
  );
  await db.supportTicket.deleteMany({ where: { id: { in: tickets.map((t) => t.id) } } });

  // Data exports.
  const exports = await db.dataExport.findMany({ where: { userId, storageId: { not: null } }, select: { storageId: true } });
  await deleteStored(
    exports.map((e) => ({ providerId: e.storageId!, resourceType: "raw" })),
    (providerId) => db.dataExport.deleteMany({ where: { userId, storageId: providerId } })
  );

  await db.$transaction(async (tx) => {
    // Their own workspaces and projects, with everything in them (deleted ones too).
    await tx.workspace.deleteMany({ where: { ownerId: userId } });
    await tx.project.deleteMany({ where: { ownerId: userId } });
    // Private Ask threads in other people's workspaces (only they could see them).
    await tx.annotation.deleteMany({ where: { createdById: userId, visibility: "PRIVATE" } });
    await tx.workspaceNote.deleteMany({ where: { createdById: userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.annotationMention.deleteMany({ where: { userId } });
    await tx.workspaceMember.deleteMany({ where: { userId } });
    await tx.projectMember.deleteMany({ where: { userId } });
    await tx.invitation.deleteMany({ where: { OR: [{ invitedById: userId }, { invitedUserId: userId }] } });
    await tx.shareLink.deleteMany({ where: { createdById: userId } });
    await tx.ownershipTransfer.deleteMany({ where: { OR: [{ fromUserId: userId }, { toUserId: userId }] } });
    await tx.memberLimitGrace.deleteMany({ where: { ownerId: userId } });
    await tx.dataExport.deleteMany({ where: { userId } });
    await tx.userPreference.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
    // Two-factor sign-in: secret, backup codes and trusted devices.
    await tx.twoFactor.deleteMany({ where: { userId } });
    // Step 10.2: monitoring counters of plan limits reached.
    await tx.usageLimitHit.deleteMany({ where: { userId } });
    await tx.verification.deleteMany({ where: { identifier: { startsWith: "trust-device-" }, value: userId } });
    await tx.verification.deleteMany({ where: { identifier: { contains: email, mode: "insensitive" } } });
    await tx.user.update({
      where: { id: userId },
      data: {
        name: DELETED_USER_NAME,
        email: deletedUserEmail(userId),
        emailVerified: false,
        twoFactorEnabled: false,
        image: null,
        username: null,
        displayUsername: null,
        usernameClaimedAt: null,
        usernameChangedAt: null,
        suspendedReason: null,
      },
    });
    await tx.accountDeletion.update({ where: { id: deletion.id }, data: { purgedAt: now, restoreTokenHash: `purged:${deletion.id}` } });
    await tx.auditLog.create({ data: { userId, action: "ACCOUNT_PURGED" } });
  });
  return { purged: true };
}

/** For the Step 10.3 daily job: erase every account past its grace period. */
export async function purgeDueAccounts(now: Date = new Date(), limit = 20): Promise<{ purged: number; failed: number }> {
  const due = await db.accountDeletion.findMany({
    where: { purgedAt: null, purgeAfter: { lte: now } },
    select: { userId: true },
    orderBy: { purgeAfter: "asc" },
    take: limit,
  });
  let purged = 0;
  let failed = 0;
  for (const d of due) {
    try {
      if ((await purgeDeletedAccount(d.userId, { now })).purged) purged++;
    } catch (err) {
      failed++;
      log.error({ err: errInfo(err), userId: d.userId }, "[account-deletion] purge failed");
    }
  }
  return { purged, failed };
}

/** Admins (support, a verified erasure request): erase now; only for an account already deleted. */
export async function adminPurgeDeletedAccount(actor: Actor, userId: string, force: boolean) {
  if (actor.role !== "ADMIN") throw Errors.forbidden("Admin role required");
  const result = await purgeDeletedAccount(userId, { force });
  await db.auditLog.create({ data: { userId: actor.userId, action: "ADMIN_PURGE_DELETED_ACCOUNT", targetId: userId, metadata: { force } } });
  return result;
}

/**
 * The data part of step 1 on its own: sets `User.deletedAt` and soft-deletes
 * the person's Klecx notes with the same timestamp (kept for callers that
 * only need that; `requestAccountDeletion` does it inside its transaction).
 * Calling it again keeps the first date (and still covers notes that were missed).
 */
export async function softDeleteUser(
  userId: string
): Promise<{ deletedAt: Date; notesDeleted: number }> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } });
    if (!user) throw Errors.notFound("User");
    const deletedAt = user.deletedAt ?? new Date();
    if (!user.deletedAt) await tx.user.update({ where: { id: userId }, data: { deletedAt } });
    const notes = await tx.workspaceNote.updateMany({
      where: { createdById: userId, deletedAt: null },
      data: { deletedAt },
    });
    return { deletedAt, notesDeleted: notes.count };
  });
}
