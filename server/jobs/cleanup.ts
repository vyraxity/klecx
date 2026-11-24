import "server-only";
import { db } from "@/server/db/client";
import { log, errInfo } from "@/server/log";
import { getStorageProvider, type StorageResourceType } from "@/server/storage";
import { SUPPORT_SCREENSHOT_RETENTION_DAYS } from "@/lib/support/screenshots";
import type { JobResult } from "./runner";

/**
 * Step 10.3 — storage and data clean-up. Every file is deleted from storage
 * **before** its row (or the row that points to it), so a failure leaves the
 * row for the next run to retry; a file is never left without a row that
 * finds it (except read-aloud audio, see `purgeSpeechCache`).
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Unfinished uploads (`PENDING`) are dropped after this long. */
export const PENDING_UPLOAD_TTL_MS = HOUR;
/** Uploaded files never sent with a message (or added as a document) are dropped after this long. */
export const UNLINKED_UPLOAD_TTL_MS = DAY;
/** Deleted workspaces (and projects, responses) can be restored this long, then they are erased. */
export const DELETED_RETENTION_DAYS = 30;
/** Read-aloud audio not played for this long is deleted (a later replay synthesizes it again). */
export const SPEECH_CACHE_RETENTION_DAYS = 90;
/** Job run history kept for the alerts and the admin console. */
export const JOB_RUN_RETENTION_DAYS = 30;

const BATCH = 100;

async function deleteFile(providerId: string, resourceType: StorageResourceType, isPublic = false): Promise<boolean> {
  try {
    return await getStorageProvider().delete(providerId, { resourceType, isPublic });
  } catch {
    return false;
  }
}

/**
 * `orphan-attachments` (hourly): uploads never finished (PENDING > 1 h),
 * uploads never used (a message's image or file, not sent within 24 h, not
 * added as a workspace document), and data-export ZIPs past their 24-hour
 * download window (Step 9.5). Files of deleted workspaces wait for `purge-deleted`.
 */
export async function cleanOrphanAttachments(now: Date = new Date()): Promise<JobResult> {
  const pendingBefore = new Date(now.getTime() - PENDING_UPLOAD_TTL_MS);
  const unlinkedBefore = new Date(now.getTime() - UNLINKED_UPLOAD_TTL_MS);
  const candidates = await db.attachment.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: "PENDING", createdAt: { lt: pendingBefore } },
        {
          status: "READY",
          kind: { in: ["IMAGE", "DOCUMENT"] },
          responseId: null,
          uploadedDocumentResponse: null,
          avatarUser: null,
          createdAt: { lt: unlinkedBefore },
          OR: [{ workspaceId: null }, { workspace: { deletedAt: null } }],
        },
      ],
    },
    select: { id: true, providerId: true, resourceType: true, kind: true, status: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  let attachments = 0;
  let failed = 0;
  for (const a of candidates) {
    if (!(await deleteFile(a.providerId, a.resourceType as StorageResourceType, a.kind === "AVATAR"))) {
      failed++;
      continue;
    }
    // Conditional: a message sent in the meantime keeps its file row (the file is gone, the row says so).
    const marked = await db.attachment.updateMany({
      where: { id: a.id, deletedAt: null },
      data: { status: "DELETED", deletedAt: now },
    });
    attachments += marked.count;
  }

  const expiredExports = await db.dataExport.findMany({
    where: { expiresAt: { lt: now }, storageId: { not: null } },
    select: { id: true, storageId: true },
    take: BATCH,
  });
  let exports = 0;
  for (const e of expiredExports) {
    if (!(await deleteFile(e.storageId!, "raw"))) {
      failed++;
      continue;
    }
    const cleared = await db.dataExport.updateMany({
      where: { id: e.id, storageId: e.storageId },
      data: { storageId: null },
    });
    exports += cleared.count;
  }

  return {
    attachments,
    exports,
    failed,
    more: candidates.length === BATCH || expiredExports.length === BATCH,
  };
}

/** Erases one workspace: its files from storage, then the rows (cascade). */
async function eraseWorkspace(workspaceId: string): Promise<void> {
  const files = await db.attachment.findMany({
    where: { workspaceId },
    select: { id: true, providerId: true, resourceType: true, status: true },
  });
  for (const f of files) {
    if (f.status !== "DELETED" && !(await deleteFile(f.providerId, f.resourceType as StorageResourceType))) {
      throw Object.assign(new Error("Storage delete failed"), { code: "storage_delete_failed" });
    }
    await db.attachment.deleteMany({ where: { id: f.id } });
  }
  await db.workspace.deleteMany({ where: { id: workspaceId, deletedAt: { not: null } } });
}

/**
 * `purge-deleted` (daily): workspaces, projects and responses deleted more
 * than 30 days ago are erased with everything in them (the Privacy Policy's
 * "restorable for 30 days, then permanently deleted"; `restoreWorkspace()`
 * refuses after 30 days). A project's workspaces aren't deleted with it (they
 * were never deleted by deleting the project): they lose the project link.
 * Credit ledger entries stay (accounting); the AI calls' rows go with the
 * workspace, as in the account erasure.
 */
export async function purgeDeletedContent(now: Date = new Date()): Promise<JobResult> {
  const before = new Date(now.getTime() - DELETED_RETENTION_DAYS * DAY);
  let failed = 0;

  const workspaces = await db.workspace.findMany({
    where: { deletedAt: { lt: before } },
    select: { id: true },
    orderBy: { deletedAt: "asc" },
    take: 20,
  });
  let workspacesPurged = 0;
  for (const w of workspaces) {
    try {
      await eraseWorkspace(w.id);
      workspacesPurged++;
    } catch (err) {
      failed++;
      log.error({ job: "purge-deleted", err: errInfo(err) }, "could not erase a workspace");
    }
  }

  const projects = await db.project.deleteMany({ where: { deletedAt: { lt: before } } });

  const responses = await db.response.findMany({
    where: { deletedAt: { lt: before } },
    select: { id: true, attachments: { select: { id: true, providerId: true, resourceType: true, status: true } } },
    take: BATCH,
  });
  let responsesPurged = 0;
  for (const r of responses) {
    try {
      for (const f of r.attachments) {
        if (f.status !== "DELETED" && !(await deleteFile(f.providerId, f.resourceType as StorageResourceType))) {
          throw Object.assign(new Error("Storage delete failed"), { code: "storage_delete_failed" });
        }
        await db.attachment.deleteMany({ where: { id: f.id } });
      }
      const deleted = await db.response.deleteMany({ where: { id: r.id, deletedAt: { not: null } } });
      responsesPurged += deleted.count;
    } catch (err) {
      failed++;
      log.error({ job: "purge-deleted", err: errInfo(err) }, "could not erase a response");
    }
  }

  return {
    workspaces: workspacesPurged,
    projects: projects.count,
    responses: responsesPurged,
    failed,
    more: workspaces.length === 20 || responses.length === BATCH,
  };
}

/** `purge-support-screenshots` (daily, F5.8): screenshots older than 90 days (Privacy Policy). */
export async function purgeSupportScreenshots(now: Date = new Date()): Promise<JobResult> {
  const before = new Date(now.getTime() - SUPPORT_SCREENSHOT_RETENTION_DAYS * DAY);
  const due = await db.supportAttachment.findMany({
    where: { createdAt: { lt: before } },
    select: { id: true, providerId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  let deleted = 0;
  let failed = 0;
  for (const s of due) {
    if (!(await deleteFile(s.providerId, "image"))) {
      failed++;
      continue;
    }
    deleted += (await db.supportAttachment.deleteMany({ where: { id: s.id } })).count;
  }
  return { deleted, failed, more: due.length === BATCH };
}

/**
 * `purge-speech-cache` (daily, Step 9.4): read-aloud audio not played for
 * 90 days. The row goes first, only while it is still unused (a replay in
 * the meantime keeps it), then the file. A file whose delete fails stays in
 * storage without a row (logged; harmless: the same text and voice would
 * upload to the same path again).
 */
export async function purgeSpeechCache(now: Date = new Date()): Promise<JobResult> {
  const before = new Date(now.getTime() - SPEECH_CACHE_RETENTION_DAYS * DAY);
  const due = await db.speechCache.findMany({
    where: { lastUsedAt: { lt: before } },
    select: { id: true, storageId: true },
    orderBy: { lastUsedAt: "asc" },
    take: BATCH * 2,
  });
  let deleted = 0;
  let fileErrors = 0;
  for (const s of due) {
    const row = await db.speechCache.deleteMany({ where: { id: s.id, lastUsedAt: { lt: before } } });
    if (row.count === 0) continue;
    deleted++;
    if (!(await deleteFile(s.storageId, "video"))) {
      fileErrors++;
      log.warn({ job: "purge-speech-cache" }, "audio file could not be deleted from storage");
    }
  }
  return { deleted, fileErrors, more: due.length === BATCH * 2 };
}

/** `prune-job-runs` (daily): job history older than 30 days. */
export async function pruneJobRuns(now: Date = new Date()): Promise<JobResult> {
  const before = new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * DAY);
  const runs = await db.jobRun.deleteMany({ where: { startedAt: { lt: before } } });
  return { deleted: runs.count };
}
