import "server-only";
import { db } from "@/server/db/client";
import type { Actor } from "@/server/auth/session";
import { Errors } from "@/server/http/errors";
import { logActivity } from "./activity";
import { startGraceIfOverLimit } from "./member-limits";
import { DELETED_RETENTION_DAYS } from "@/server/jobs/cleanup";

/**
 * Pre-10.6 fix (owner, 2026-11-27): "Recently deleted". The Privacy Policy
 * keeps deleted workspaces and projects for `DELETED_RETENTION_DAYS` before
 * the daily `purge-deleted` job erases them; within that time their owner
 * can see and restore them. Owners only (members lose access on delete), and
 * no "delete permanently now" (owner's decision).
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function retentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - DELETED_RETENTION_DAYS * DAY_MS);
}

/** When the purge job erases it, and whole days left (0 on the last day). */
function purgeInfo(deletedAt: Date, now = new Date()) {
  const purgeAt = new Date(deletedAt.getTime() + DELETED_RETENTION_DAYS * DAY_MS);
  const daysLeft = Math.max(0, Math.floor((purgeAt.getTime() - now.getTime()) / DAY_MS));
  return { purgeAt, daysLeft };
}

export interface RecentlyDeletedDto {
  retentionDays: number;
  workspaces: Array<{
    id: string;
    title: string;
    deletedAt: Date;
    purgeAt: Date;
    daysLeft: number;
    /** The project it was in, when that project is also deleted (it comes back without it). */
    deletedProjectName: string | null;
  }>;
  projects: Array<{
    id: string;
    name: string;
    deletedAt: Date;
    purgeAt: Date;
    daysLeft: number;
    workspaceCount: number;
  }>;
}

export async function listRecentlyDeleted(actor: Actor): Promise<RecentlyDeletedDto> {
  const now = new Date();
  const since = retentionCutoff(now);
  const [workspaces, projects] = await Promise.all([
    db.workspace.findMany({
      where: { ownerId: actor.userId, deletedAt: { gte: since } },
      orderBy: { deletedAt: "desc" },
      take: 200,
      select: {
        id: true,
        title: true,
        deletedAt: true,
        project: { select: { name: true, deletedAt: true } },
      },
    }),
    db.project.findMany({
      where: { ownerId: actor.userId, deletedAt: { gte: since } },
      orderBy: { deletedAt: "desc" },
      take: 200,
      select: {
        id: true,
        name: true,
        deletedAt: true,
        _count: { select: { workspaces: { where: { deletedAt: null } } } },
      },
    }),
  ]);

  return {
    retentionDays: DELETED_RETENTION_DAYS,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      title: w.title,
      deletedAt: w.deletedAt!,
      ...purgeInfo(w.deletedAt!, now),
      deletedProjectName: w.project?.deletedAt ? w.project.name : null,
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      deletedAt: p.deletedAt!,
      ...purgeInfo(p.deletedAt!, now),
      workspaceCount: p._count.workspaces,
    })),
  };
}

/**
 * Restores a deleted workspace (owner only; 404 for anyone else, like before).
 * If its project is still deleted, it comes back without a project.
 */
export async function restoreDeletedWorkspace(actor: Actor, workspaceId: string) {
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      ownerId: true,
      deletedAt: true,
      projectId: true,
      project: { select: { deletedAt: true } },
    },
  });
  if (!ws || ws.ownerId !== actor.userId) throw Errors.notFound("Workspace");
  if (!ws.deletedAt) return db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (ws.deletedAt < retentionCutoff()) {
    throw Errors.conflict("Workspace deleted more than 30 days ago cannot be restored", "restore_expired");
  }

  const leaveProject = Boolean(ws.projectId && ws.project?.deletedAt);
  const restored = await db.workspace.update({
    where: { id: workspaceId },
    data: { deletedAt: null, ...(leaveProject ? { projectId: null } : {}) },
  });

  await logActivity(db, {
    workspaceId,
    projectId: restored.projectId,
    actorId: actor.userId,
    action: "workspace.restored",
    targetType: "workspace",
    targetId: workspaceId,
  });
  // Its members count again toward the owner's collaborator limit.
  await startGraceIfOverLimit(actor.userId);
  return restored;
}

/** Restores a deleted project (owner only). Its workspaces were never deleted with it. */
export async function restoreDeletedProject(actor: Actor, projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true, deletedAt: true },
  });
  if (!project || project.ownerId !== actor.userId) throw Errors.notFound("Project");
  if (!project.deletedAt) return db.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.deletedAt < retentionCutoff()) {
    throw Errors.conflict("Project deleted more than 30 days ago cannot be restored", "restore_expired");
  }

  const restored = await db.project.update({ where: { id: projectId }, data: { deletedAt: null } });
  await logActivity(db, {
    projectId,
    actorId: actor.userId,
    action: "project.restored",
    targetType: "project",
    targetId: projectId,
  });
  await startGraceIfOverLimit(actor.userId);
  return restored;
}
