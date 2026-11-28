import "server-only";
import { DEFAULT_MODEL_CHOICES } from "@/lib/ai/default-model";
import { minimumMessageCredits } from "@/lib/ai/model-catalog";
import { db } from "@/server/db/client";
import type { Actor } from "@/server/auth/session";
import { Errors } from "@/server/http/errors";
import { logActivity } from "./activity";
import { countWorkspaceMembers } from "./members";
import { getEntitlements } from "@/server/billing/entitlements";
import { getAccountByUserId } from "./credits";
import { getMemberMonthlySpend, resolveMemberMonthlyCreditCap } from "./billing-owner";
import { toPage } from "@/server/http/pagination";
import {
  requireProject,
  requireWorkspace,
  resolveWorkspaceRole,
} from "@/server/authz/access";
import { MAX_ANNOTATION_DEPTH } from "@/lib/annotations/limits";
import type {
  CreateWorkspaceInput,
  SearchWorkspacesQuery,
  UpdateWorkspaceInput,
} from "@/lib/schemas/workspace";

export type ListWorkspacesOptions = {
  cursor?: string;
  limit?: number;
  projectId?: string;
  standalone?: boolean;
  archived?: boolean;
  q?: string;
};

/** Projects the person owns or is a member of (not deleted): their workspaces are visible to them. */
async function accessibleProjectIds(userId: string): Promise<string[]> {
  const [owned, member] = await Promise.all([
    db.project.findMany({ where: { ownerId: userId, deletedAt: null }, select: { id: true } }),
    db.projectMember.findMany({ where: { userId, project: { deletedAt: null } }, select: { projectId: true } }),
  ]);
  return [...new Set([...owned.map((p) => p.id), ...member.map((m) => m.projectId)])];
}

export async function listWorkspaces(
  actor: Actor,
  query: ListWorkspacesOptions = {}
) {
  const limit = query.limit ?? 20;

  // Step 10.5: the workspaces this person can open, found through small
  // indexed lookups first (memberships, then projects they own or belong to),
  // so the list query is a union of index scans instead of a scan of every
  // workspace (EXPLAIN on 200k workspaces: 124 ms → see docs/performance.md).
  const [memberships, projectIds] = await Promise.all([
    db.workspaceMember.findMany({ where: { userId: actor.userId }, select: { workspaceId: true } }),
    accessibleProjectIds(actor.userId),
  ]);
  const accessibleCondition = {
    OR: [
      { ownerId: actor.userId },
      ...(memberships.length ? [{ id: { in: memberships.map((m) => m.workspaceId) } }] : []),
      ...(projectIds.length ? [{ projectId: { in: projectIds } }] : []),
    ],
  };

  const where = {
    deletedAt: null,
    archivedAt: query.archived ? { not: null } : null,
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.standalone ? { projectId: null } : {}),
    ...(query.q
      ? { title: { contains: query.q, mode: "insensitive" as const } }
      : {}),
    ...accessibleCondition,
  };

  const found = await db.workspace.findMany({
    where,
    take: limit + 1,
    ...(query.cursor
      ? {
          cursor: { id: query.cursor },
          skip: 1,
        }
      : {}),
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    include: {
      project: {
        select: {
          id: true,
          name: true,
          deletedAt: true,
        },
      },
    },
  });

  // Member counts for this page only (`_count` in the query above made the
  // database count the members of every workspace before joining).
  const counts = found.length
    ? await db.workspaceMember.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: found.map((w) => w.id) } },
        _count: { _all: true },
      })
    : [];
  const countById = new Map(counts.map((c) => [c.workspaceId, c._count._all]));
  // Pre-10.6 fix: a deleted project's workspaces aren't deleted with it; they
  // show as standalone (not under a project nobody can open) until the
  // project is restored from Recently deleted.
  const rows = found.map(({ project, ...w }) => {
    const live = project && !project.deletedAt ? { id: project.id, name: project.name } : null;
    return {
      ...w,
      projectId: live ? w.projectId : null,
      project: live,
      _count: { members: countById.get(w.id) ?? 0 },
    };
  });

  return toPage(rows, limit);
}

export async function createWorkspace(
  actor: Actor,
  input: CreateWorkspaceInput
) {
  if (input.projectId) {
    // If projectId specified, require project EDITOR+
    await requireProject(actor, input.projectId, "workspace.generate");
  }

  const trimmedTitle = input.title?.trim();
  const title = trimmedTitle || "New workspace";
  const titleSource = trimmedTitle ? ("USER" as const) : ("AUTO" as const);

  const ws = await db.workspace.create({
    data: {
      ownerId: actor.userId,
      projectId: input.projectId ?? null,
      title,
      titleSource,
    },
  });

  await logActivity(db, {
    workspaceId: ws.id,
    projectId: ws.projectId,
    actorId: actor.userId,
    action: "workspace.created",
    targetType: "workspace",
    targetId: ws.id,
    meta: { title: ws.title },
  });

  return ws;
}

export type WorkspaceSourceProvenance =
  | { canAccess: false; removed: boolean }
  | {
      canAccess: true;
      removed: false;
      sourceWorkspaceId: string;
      sourceWorkspaceTitle: string;
      sourceAnnotationId: string | null;
      threadParam: string | null;
      annotationRemoved: boolean;
    };

async function resolveWorkspaceSourceProvenance(
  actor: Actor,
  sourceWorkspaceId: string | null,
  sourceAnnotationId: string | null
): Promise<WorkspaceSourceProvenance | null> {
  if (!sourceWorkspaceId) return null;

  const sourceWs = await db.workspace.findFirst({
    where: { id: sourceWorkspaceId },
    select: { id: true, title: true, deletedAt: true },
  });

  if (!sourceWs || sourceWs.deletedAt !== null) {
    return { canAccess: false, removed: true };
  }

  const sourceAccess = await resolveWorkspaceRole(actor.userId, sourceWs.id);
  if (!sourceAccess) {
    // Do not leak the source workspace title or thread chain to non-members.
    return { canAccess: false, removed: false };
  }

  let threadParam: string | null = null;
  let annotationRemoved = false;

  if (sourceAnnotationId) {
    const chainRows = await db.$queryRaw<
      Array<{
        id: string;
        depth: number;
        visibility: string;
        created_by_id: string;
      }>
    >`
      WITH RECURSIVE chain AS (
        SELECT id, parent_annotation_id, depth, visibility, created_by_id, 0 AS step
        FROM annotations
        WHERE id = ${sourceAnnotationId}
          AND workspace_id = ${sourceWs.id}
          AND deleted_at IS NULL

        UNION ALL

        SELECT parent.id, parent.parent_annotation_id, parent.depth, parent.visibility, parent.created_by_id, c.step + 1 AS step
        FROM annotations parent
        INNER JOIN chain c ON parent.id = c.parent_annotation_id
        WHERE parent.deleted_at IS NULL AND c.step < ${MAX_ANNOTATION_DEPTH}
      )
      SELECT id, depth, visibility, created_by_id
      FROM chain
      ORDER BY depth ASC;
    `;

    const hasHidden = chainRows.some(
      (r) => r.visibility === "PRIVATE" && r.created_by_id !== actor.userId
    );
    // The chain is complete when it holds the question and reaches level 1.
    // A deleted question or ancestor cuts it short.
    const isComplete =
      chainRows.some((r) => r.id === sourceAnnotationId) &&
      chainRows[0]?.depth === 0;

    if (!isComplete) {
      annotationRemoved = true;
    } else if (!hasHidden) {
      threadParam = chainRows.map((r) => r.id).join(",");
    }
    // A private thread of someone else still exists: link to the workspace
    // only, without saying the question was removed.
  }

  return {
    canAccess: true,
    removed: false,
    sourceWorkspaceId: sourceWs.id,
    sourceWorkspaceTitle: sourceWs.title,
    sourceAnnotationId,
    threadParam,
    annotationRemoved,
  };
}

export async function getWorkspace(actor: Actor, workspaceId: string) {
  const { role, capabilities } = await requireWorkspace(actor, workspaceId, "workspace.read");

  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    include: {
      project: {
        select: {
          id: true,
          name: true,
        },
      },
      _count: {
        select: {
          members: true,
        },
      },
    },
  });

  if (!workspace) throw Errors.notFound("Workspace");

  const [memberCount, sourceProvenance, ownerEntitlements, attachmentCount, ownerAccount] =
    await Promise.all([
      countWorkspaceMembers(workspaceId),
      resolveWorkspaceSourceProvenance(
        actor,
        workspace.sourceWorkspaceId,
        workspace.sourceAnnotationId
      ),
      getEntitlements(workspace.ownerId),
      // Same count as the upload check in `attachment.ts`.
      db.attachment.count({ where: { workspaceId, status: { not: "DELETED" } } }),
      getAccountByUserId(workspace.ownerId),
    ]);

  return {
    ...workspace,
    role,
    capabilities: Array.from(capabilities),
    // Effective headcount (owner + explicit + inherited project members);
    // `_count.members` would miss inherited access.
    memberCount,
    sourceProvenance,
    // Download formats come from the owner's plan (decided 2026-11-14).
    exportFormats: [...ownerEntitlements.limits.exportFormats],
    memberCreditCapReached: await memberCreditCapReached(actor.userId, workspace, ownerAccount?.id),
    // F4.4: the owner's plan sets the attachment limits (the server re-checks on upload).
    attachmentLimits: {
      max: ownerEntitlements.limits.attachmentsPerWorkspace,
      used: attachmentCount,
      maxFileMB: ownerEntitlements.limits.maxFileMB,
    },
    // F4.4: the owner pays for generations; only a yes/no, never the balance.
    // No account yet = the free grant is created on first use.
    ownerOutOfCredits: ownerAccount
      ? ownerAccount.planBalance + ownerAccount.topupBalance <= 0
      : false,
    ...composerModelInfo(role, ownerEntitlements.models, ownerAccount),
  };
}

/**
 * Pre-10.6 fix: what the composer needs to pick its default model and warn
 * before a message is refused for credits. The text models of the owner's
 * plan (the owner pays, so their plan decides what runs here), whether the
 * owner's balance covers the smallest message of each (yes/no only), and the
 * balance itself only for the owner (it's theirs).
 */
function composerModelInfo(
  role: string,
  ownerModels: readonly string[],
  ownerAccount: { planBalance: number; topupBalance: number } | null
) {
  const textModels = DEFAULT_MODEL_CHOICES.filter((m) => ownerModels.includes(m));
  // No account yet: the free grant is created on first use, so don't warn.
  const balance = ownerAccount ? ownerAccount.planBalance + ownerAccount.topupBalance : null;
  return {
    ownerTextModels: textModels,
    ownerCanAfford: Object.fromEntries(
      textModels.map((m) => [m, balance === null || balance >= minimumMessageCredits(m)])
    ) as Record<string, boolean>,
    ownerBalance: role === "OWNER" ? balance : null,
  };
}

/**
 * F4.4: the monthly credit limit the owner set for this member (across the
 * owner's workspaces, as `reserveForWorkspaceGeneration` counts it) is used
 * up. `null` for the owner, an unlimited member, or room left. The server
 * re-checks on every generation.
 */
async function memberCreditCapReached(
  actorId: string,
  workspace: { id: string; ownerId: string; projectId: string | null },
  billedAccountId: string | undefined
): Promise<{ cap: number } | null> {
  if (actorId === workspace.ownerId) return null;
  const cap = await resolveMemberMonthlyCreditCap(actorId, workspace);
  if (cap === null) return null;
  // No account yet = nothing spent from it yet.
  const used = billedAccountId ? await getMemberMonthlySpend(actorId, billedAccountId) : 0;
  return used >= cap ? { cap } : null;
}

export async function updateWorkspace(
  actor: Actor,
  workspaceId: string,
  input: UpdateWorkspaceInput
) {
  // Always authorize first, ensuring non-members and soft-deleted resources get 404 (never 403).
  // Pre-10.6 fix PR 8: archiving and un-archiving need "workspace.archive" only. The
  // other fields need "workspace.rename" and are refused while the workspace is
  // archived, unless the same request takes it out of the archive. (The rename check
  // used to come first, so `{ archived: false }` always failed with 409.)
  const access = await requireWorkspace(
    actor,
    workspaceId,
    input.archived !== undefined ? "workspace.archive" : "workspace.rename"
  );
  if (input.title !== undefined || input.projectId !== undefined) {
    if (!access.capabilities.has("workspace.rename")) throw Errors.forbidden();
    if (access.ws.archivedAt && input.archived !== false) {
      throw Errors.conflict("Workspace is archived");
    }
  }

  // Reject updates containing no supported fields
  const hasSupportedFields = Object.values(input).some((v) => v !== undefined);
  if (!hasSupportedFields) {
    throw Errors.validation({ formErrors: ["No supported update fields provided"] });
  }

  // Field-specific authorization checks

  if (input.projectId !== undefined && input.projectId !== null) {
    await requireProject(actor, input.projectId, "workspace.generate");
  }

  const updated = await db.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.title !== undefined
        ? { title: input.title.trim(), titleSource: "USER" as const }
        : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.archived !== undefined
        ? { archivedAt: input.archived ? new Date() : null }
        : {}),
    },
  });

  if (input.title !== undefined) {
    await logActivity(db, {
      workspaceId,
      projectId: updated.projectId,
      actorId: actor.userId,
      action: "workspace.renamed",
      targetType: "workspace",
      targetId: workspaceId,
      meta: { title: updated.title },
    });
  }

  if (input.archived !== undefined) {
    await logActivity(db, {
      workspaceId,
      projectId: updated.projectId,
      actorId: actor.userId,
      action: input.archived ? "workspace.archived" : "workspace.unarchived",
      targetType: "workspace",
      targetId: workspaceId,
    });
  }

  return updated;
}

export async function deleteWorkspace(actor: Actor, workspaceId: string) {
  // Soft delete: owner only
  await requireWorkspace(actor, workspaceId, "workspace.delete");

  const deleted = await db.workspace.update({
    where: { id: workspaceId },
    data: { deletedAt: new Date() },
  });

  await logActivity(db, {
    workspaceId,
    projectId: deleted.projectId,
    actorId: actor.userId,
    action: "workspace.deleted",
    targetType: "workspace",
    targetId: workspaceId,
  });

  return deleted;
}

/**
 * Restores a deleted workspace within the 30 days (pre-10.6 fix: the logic
 * lives in `recently-deleted.ts`; a workspace whose project is also deleted
 * comes back without it).
 */
export async function restoreWorkspace(actor: Actor, workspaceId: string) {
  const { restoreDeletedWorkspace } = await import("./recently-deleted");
  return restoreDeletedWorkspace(actor, workspaceId);
}

export async function touchWorkspaceActivity(workspaceId: string) {
  try {
    return await db.workspace.update({
      where: { id: workspaceId },
      data: { lastActivityAt: new Date() },
    });
  } catch {
    // Non-fatal if workspace doesn't exist
    return null;
  }
}

export async function searchWorkspaces(
  actor: Actor,
  query: SearchWorkspacesQuery
) {
  const q = query.q.trim();
  const targetWorkspaceId = query.workspaceId || query.chatId;
  const isScoped =
    (query.scope === "this chat" || query.scope === "this-chat") &&
    Boolean(targetWorkspaceId);

  if (isScoped && targetWorkspaceId) {
    // Must enforce read access to the requested workspace
    await requireWorkspace(actor, targetWorkspaceId, "workspace.read");

    const responseDelegate = (db as any).response;
    const responses = responseDelegate
      ? await responseDelegate.findMany({
          where: {
            chatId: targetWorkspaceId,
            OR: [
              { question: { contains: q, mode: "insensitive" } },
              { response: { contains: q, mode: "insensitive" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
      : [];

    return { results: responses };
  }

  // "all chats" scope: search accessible workspace titles and responses
  const accessibleCondition = {
    OR: [
      { ownerId: actor.userId },
      {
        members: {
          some: {
            userId: actor.userId,
          },
        },
      },
      {
        project: {
          deletedAt: null,
          OR: [
            { ownerId: actor.userId },
            { members: { some: { userId: actor.userId } } },
          ],
        },
      },
    ],
  };

  const workspaces = await db.workspace.findMany({
    where: {
      deletedAt: null,
      title: { contains: q, mode: "insensitive" },
      ...accessibleCondition,
    },
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: 20,
  });

  const responseDelegate = (db as any).response;
  const responses = responseDelegate
    ? await responseDelegate.findMany({
        where: {
          chat: {
            deletedAt: null,
            ...accessibleCondition,
          },
          OR: [
            { question: { contains: q, mode: "insensitive" } },
            { response: { contains: q, mode: "insensitive" } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      })
    : [];

  return { results: [...workspaces, ...responses] };
}
