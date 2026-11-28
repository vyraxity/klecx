import "server-only";
import { log, errInfo } from "@/server/log";

import { db } from "@/server/db/client";
import { Errors } from "@/server/http/errors";
import { notify } from "@/server/services/notify";
import { logActivity } from "@/server/services/activity";
import { limit } from "@/server/http/rate-limit";
import type { Actor } from "@/server/auth/session";
import type { Permission } from "@/server/authz/permissions";
import type { Prisma } from "@/server/db/generated/client";

type DbOrTx = Prisma.TransactionClient | typeof db;

/**
 * Regex matching valid usernames (3-30 chars, lowercase letter followed by letters/digits/underscores).
 * Same rules as usernames across the app.
 */
export const MENTION_RE = /(^|[\s(])@([a-z][a-z0-9_]{2,29})\b/g;

const EXCERPT_MAX = 200;

/**
 * Strips the `@klecx` mention token and cleans up remaining whitespace.
 */
export function extractInstructionFromKlecx(text: string): string {
  return text
    .replace(/(^|[\s(])@klecx\b/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * `@klecx` records a note that steers later answers, so it needs the right to
 * ask or generate. Everyone else can still mention people.
 */
export function assertCanCreateKlecxNote(capabilities: Set<Permission>): void {
  if (
    !capabilities.has("workspace.ask") &&
    !capabilities.has("workspace.generate")
  ) {
    throw Errors.forbidden(
      "You don't have permission to record Klecx notes",
      "klecx_note_forbidden"
    );
  }
}

/** Pre-10.6 fix: `@all` mentions everyone in the workspace (never Klecx). */
export const ALL_MENTION_HANDLE = "all";

/**
 * Resolves mentions from a given text inside a workspace.
 * Returns only the ids of people who are mentionable here (same set as
 * `listMentionables`): the workspace owner, the project owner, and
 * non-suspended workspace / project members. Unknown names stay plain text.
 * Also returns `klecx: true` if `@klecx` was mentioned, and for `@all`
 * (`all: true`) everyone who has access in `allUserIds` (whether they may
 * use it is the caller's check: `syncMentionsAndNotes`).
 */
export async function resolveMentions(
  workspaceId: string,
  text: string,
  client: DbOrTx = db
): Promise<{ userIds: string[]; klecx: boolean; all: boolean; allUserIds: string[] }> {
  const none = { userIds: [], klecx: false, all: false, allUserIds: [] };
  if (!text) {
    return none;
  }

  const handles = new Set<string>();
  const re = new RegExp(MENTION_RE.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const handle = match[2];
    if (handle) {
      handles.add(handle.toLowerCase());
    }
  }

  const klecx = handles.has("klecx");
  handles.delete("klecx");
  // Reserved: no account can be called "all" (lib/username.ts).
  const all = handles.has(ALL_MENTION_HANDLE);
  handles.delete(ALL_MENTION_HANDLE);

  if (handles.size === 0 && !all) {
    return { ...none, klecx };
  }

  const workspace = await client.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: {
      id: true,
      ownerId: true,
      projectId: true,
      project: { select: { ownerId: true, deletedAt: true } },
    },
  });

  if (!workspace) {
    return { ...none, klecx };
  }

  const project =
    workspace.projectId && workspace.project && !workspace.project.deletedAt
      ? { id: workspace.projectId, ownerId: workspace.project.ownerId }
      : null;

  const validUserIds = new Set<string>();
  if (handles.size > 0) {
    const candidateUsers = await client.user.findMany({
      where: {
        username: { in: Array.from(handles), mode: "insensitive" },
      },
      select: {
        id: true,
        workspaceMemberships: {
          where: { workspaceId: workspace.id, suspendedAt: null },
          select: { userId: true },
        },
        projectMemberships: project
          ? {
              where: { projectId: project.id, suspendedAt: null },
              select: { userId: true },
            }
          : false,
      },
    });

    for (const u of candidateUsers) {
      const isOwner = u.id === workspace.ownerId || u.id === project?.ownerId;
      const isDirectMember = u.workspaceMemberships.length > 0;
      const isProjectMember = Boolean(
        u.projectMemberships && u.projectMemberships.length > 0
      );

      if (isOwner || isDirectMember || isProjectMember) {
        validUserIds.add(u.id);
      }
    }
  }

  const allUserIds = all ? await workspaceAudience(client, workspace, project) : [];

  return { userIds: Array.from(validUserIds), klecx, all, allUserIds };
}

/**
 * Everyone `@all` reaches: the workspace and project owners and every
 * non-suspended workspace or project member, without deleted accounts.
 */
async function workspaceAudience(
  client: DbOrTx,
  workspace: { id: string; ownerId: string },
  project: { id: string; ownerId: string } | null
): Promise<string[]> {
  const [wsMembers, projectMembers] = await Promise.all([
    client.workspaceMember.findMany({
      where: { workspaceId: workspace.id, suspendedAt: null },
      select: { userId: true },
    }),
    project
      ? client.projectMember.findMany({
          where: { projectId: project.id, suspendedAt: null },
          select: { userId: true },
        })
      : Promise.resolve([] as { userId: string }[]),
  ]);
  const ids = new Set<string>([
    workspace.ownerId,
    ...(project ? [project.ownerId] : []),
    ...wsMembers.map((m) => m.userId),
    ...projectMembers.map((m) => m.userId),
  ]);
  const active = await client.user.findMany({
    where: { id: { in: Array.from(ids) }, deletedAt: null },
    select: { id: true },
  });
  return active.map((u) => u.id);
}

/** How many people `@all` would notify for this author (everyone but them). */
export async function countAllMentionAudience(
  workspaceId: string,
  authorId: string,
  client: DbOrTx = db
): Promise<number> {
  const { allUserIds } = await resolveMentions(workspaceId, `@${ALL_MENTION_HANDLE}`, client);
  return allUserIds.filter((id) => id !== authorId).length;
}

export interface SyncMentionsOptions {
  workspaceId: string;
  annotationId: string;
  messageId: string;
  text: string;
  anchorExact: string;
  actor: Actor;
  capabilities: Set<Permission>;
  currentVisibility: "PRIVATE" | "WORKSPACE";
  /**
   * False when the annotation sits inside a private thread: it quotes a
   * private answer, so it can't become visible to the workspace. People
   * can't open it, so `@user` stays plain text there; `@klecx` still records
   * a note.
   */
  canShare: boolean;
  isNewMessage: boolean;
}

export interface SyncMentionsResult {
  visibility: "PRIVATE" | "WORKSPACE";
  userIds: string[];
  klecx: boolean;
  /** `@all` was used (by someone allowed to). */
  all: boolean;
  /** Pass to `sendMentionNotifications` after the transaction commits. */
  pendingNotifications: {
    workspaceId: string;
    annotationId: string;
    messageId: string;
    quote: string;
    excerpt: string;
    authorName: string;
    /** Who wrote the message (not part of the notification payload). */
    authorId: string;
    href: string;
    userIds: string[];
    /** Of `userIds`, those reached only through `@all` ("mentioned everyone"). */
    everyoneUserIds?: string[];
  };
}

/**
 * Synchronizes mention rows, visibility and the Klecx note for one annotation
 * message. Runs on the caller's transaction, so the message, its mentions and
 * its note are saved together or not at all. It does not send anything:
 * call `sendMentionNotifications(result.pendingNotifications)` after commit.
 */
export async function syncMentionsAndNotes(
  tx: DbOrTx,
  options: SyncMentionsOptions
): Promise<SyncMentionsResult> {
  const {
    workspaceId,
    annotationId,
    messageId,
    text,
    anchorExact,
    actor,
    capabilities,
    currentVisibility,
    canShare,
    isNewMessage,
  } = options;

  const resolved = await resolveMentions(workspaceId, text, tx);
  const klecx = resolved.klecx;
  const explicitUserIds = canShare ? resolved.userIds : [];
  // Pre-10.6 fix (owner): anyone who can comment can use `@all`; in a private
  // thread (canShare false) nobody else can see it, so it reaches nobody.
  // Otherwise it stays plain text.
  const all = canShare && resolved.all && capabilities.has("workspace.comment");
  // Everyone but the author (who wrote it, so isn't "mentioned").
  const allUserIds = all ? resolved.allUserIds.filter((id) => id !== actor.userId) : [];
  const explicitSet = new Set(explicitUserIds);
  const userIds = Array.from(new Set([...explicitUserIds, ...allUserIds]));

  if (klecx) {
    assertCanCreateKlecxNote(capabilities);
  }

  // A mention makes the comment visible to the workspace (the client warned).
  let visibility = currentVisibility;
  if (
    canShare &&
    (klecx || all || userIds.length > 0) &&
    currentVisibility === "PRIVATE"
  ) {
    visibility = "WORKSPACE";
    await tx.annotation.update({
      where: { id: annotationId },
      data: { visibility: "WORKSPACE" },
    });
  }

  const existingMentions = isNewMessage
    ? []
    : await tx.annotationMention.findMany({ where: { messageId } });

  const existingUserIds = new Set(
    existingMentions
      .map((m) => m.userId)
      .filter((id): id is string => Boolean(id))
  );
  const existingHasKlecx = existingMentions.some((m) => m.isKlecx);
  const existingHasAll = existingMentions.some((m) => m.isAll);

  const newUserIds = userIds.filter((id) => !existingUserIds.has(id));
  if (newUserIds.length > 0) {
    await tx.annotationMention.createMany({
      data: newUserIds.map((userId) => ({ messageId, userId, isKlecx: false })),
      skipDuplicates: true,
    });
  }

  if (klecx && !existingHasKlecx) {
    await tx.annotationMention.create({
      data: { messageId, userId: null, isKlecx: true },
    });
  }

  if (all && !existingHasAll) {
    await tx.annotationMention.create({
      data: { messageId, userId: null, isAll: true },
    });
  }

  // On edit, drop the mentions that are no longer in the text.
  const desiredUserIds = new Set(userIds);
  const staleIds = existingMentions
    .filter((m) =>
      m.isKlecx
        ? !klecx
        : m.isAll
          ? !all
          : Boolean(m.userId && !desiredUserIds.has(m.userId))
    )
    .map((m) => m.id);
  if (staleIds.length > 0) {
    await tx.annotationMention.deleteMany({ where: { id: { in: staleIds } } });
  }

  // One note per message: a thread can hold several (the comment and each
  // reply with @klecx). Editing a message updates or archives its own note.
  if (klecx) {
    const instruction = extractInstructionFromKlecx(text);
    const existingNote = isNewMessage
      ? null
      : await tx.workspaceNote.findUnique({
          where: { messageId },
          select: { id: true },
        });

    if (existingNote) {
      await tx.workspaceNote.update({
        where: { id: existingNote.id },
        data: {
          quote: anchorExact,
          instruction,
          status: "ACTIVE",
          archivedAt: null,
        },
      });
    } else {
      const note = await tx.workspaceNote.create({
        data: {
          workspaceId,
          annotationId,
          messageId,
          createdById: actor.userId,
          quote: anchorExact,
          instruction,
          status: "ACTIVE",
        },
      });

      // No note text in the activity log (rule: no user content in logs).
      await logActivity(tx, {
        workspaceId,
        actorId: actor.userId,
        action: "note.created",
        targetType: "note",
        targetId: note.id,
      });
    }
  } else if (existingHasKlecx) {
    // `@klecx` was removed from the message that recorded the note.
    await tx.workspaceNote.updateMany({
      where: { messageId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
  }

  const notifyUserIds = newUserIds.filter((id) => id !== actor.userId);
  return {
    visibility,
    userIds,
    klecx,
    all,
    pendingNotifications: {
      workspaceId,
      annotationId,
      messageId,
      quote: anchorExact,
      excerpt:
        text.length > EXCERPT_MAX
          ? `${text.slice(0, EXCERPT_MAX - 1)}…`
          : text,
      authorName: actor.name ?? "",
      authorId: actor.userId,
      href: `/workspaces/${workspaceId}`,
      // New messages notify everyone mentioned; edits only the newly added.
      // Never the author (`@all` included), never Klecx.
      userIds: notifyUserIds,
      everyoneUserIds: notifyUserIds.filter((id) => !explicitSet.has(id)),
    },
  };
}

/**
 * Sends the MENTIONED notifications collected by `syncMentionsAndNotes`.
 * Call it after the transaction commits. A failed notification never fails
 * the comment that was already saved.
 */
export async function sendMentionNotifications(
  pending: SyncMentionsResult["pendingNotifications"]
): Promise<void> {
  const { userIds, messageId, authorId, everyoneUserIds = [], ...payload } = pending;
  const viaAll = new Set(everyoneUserIds);
  for (const userId of userIds) {
    try {
      // Step 10.1: mention spam. One author can notify one person a limited
      // number of times; beyond that the mention is kept but not notified.
      const allowed = await limit("mention:notify", `${authorId}:${userId}`).then(
        () => true,
        () => false
      );
      if (!allowed) continue;
      // `everyone`: "mentioned everyone" instead of "mentioned you".
      await notify(userId, "MENTIONED", { ...payload, everyone: viaAll.has(userId) }, {
        dedupeKey: `mention:${messageId}:${userId}`,
        email: true,
      });
    } catch (err) {
      log.error({ err: errInfo(err) }, "[mentions] notification failed");
    }
  }
}

/**
 * Archives every active WorkspaceNote of an annotation (on delete, resolve,
 * or when the annotation becomes private).
 */
export async function archiveNoteForAnnotation(
  annotationId: string,
  client: DbOrTx = db
): Promise<void> {
  await client.workspaceNote.updateMany({
    where: { annotationId, status: "ACTIVE" },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
}
