import "server-only";
import { db } from "@/server/db/client";
import { log, errInfo } from "@/server/log";
import { notify } from "@/server/services/notify";
import type { JobResult } from "./runner";

const BATCH = 200;

/**
 * `expire-invites-shares` (Step 10.3): pending invitations past their date →
 * EXPIRED. Every read already treats them as expired; this makes the stored
 * state match (lists, counts, the admin console). Share links have no stored
 * status (`computeShareStatus()` reads `expiresAt` / `revokedAt`), so there
 * is nothing to mark: the result counts them for the logs.
 */
export async function expireInvitesAndShares(now: Date = new Date()): Promise<JobResult> {
  const invites = await db.invitation.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  const expiredShares = await db.shareLink.count({
    where: { revokedAt: null, expiresAt: { lte: now } },
  });
  return { invitations: invites.count, expiredShares };
}

/**
 * `expire-ownership-transfers` (Step 10.3, F1.3): pending transfers past
 * `expiresAt` → EXPIRED, and the sender is told (in-app). Each transfer is
 * claimed by a conditional update, so the sender is told once.
 */
export async function expireOwnershipTransfers(now: Date = new Date()): Promise<JobResult> {
  const due = await db.ownershipTransfer.findMany({
    where: { status: "PENDING", expiresAt: { lt: now } },
    select: {
      id: true,
      fromUserId: true,
      toUserId: true,
      workspaceId: true,
      projectId: true,
      workspace: { select: { title: true } },
      project: { select: { name: true } },
      toUser: { select: { name: true, email: true } },
    },
    take: BATCH,
  });
  let expired = 0;
  for (const t of due) {
    const claimed = await db.ownershipTransfer.updateMany({
      where: { id: t.id, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    if (claimed.count === 0) continue;
    expired++;
    await notify(
      t.fromUserId,
      "OWNERSHIP_TRANSFER_EXPIRED",
      {
        transferId: t.id,
        toUserId: t.toUserId,
        toUserName: t.toUser.name || t.toUser.email,
        resourceName: t.workspace?.title ?? t.project?.name ?? "",
        resourceType: t.workspaceId ? "workspace" : "project",
        href: t.workspaceId ? `/workspaces/${t.workspaceId}` : `/projects/${t.projectId}`,
      },
      { dedupeKey: `transfer_expired:${t.id}` }
    ).catch((err) => log.warn({ job: "expire-ownership-transfers", err: errInfo(err) }, "notify failed"));
  }
  return { expired, more: due.length === BATCH };
}
