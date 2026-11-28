import "server-only";
import type { Actor } from "@/server/auth/session";
import { resolveWorkspaceRole } from "@/server/authz/access";
import { listWorkspaces } from "./workspace";
import { listProjects } from "./project";

/**
 * Pre-10.6 fix PR 8 (owner, 2026-11-28): the Archived tab of Settings →
 * Deleted & archived. Archiving hides a workspace or project from the sidebar
 * and lists; this is where the person finds them again. Lists every archived
 * workspace and project the person can open (their own and shared ones), each
 * with whether they may take it out of the archive ("workspace.archive":
 * the owner, the project's owner, or an admin member). Un-archiving itself is
 * `PATCH /api/v1/workspaces/:id` / `PATCH /api/v1/projects/:id` with
 * `{ archived: false }`.
 */
export const ARCHIVED_LIST_LIMIT = 200;

export interface ArchivedDto {
  workspaces: Array<{
    id: string;
    title: string;
    archivedAt: Date;
    /** The project it's in, when that project is live. */
    projectName: string | null;
    /** Someone else's workspace, shared with the person. */
    shared: boolean;
    canUnarchive: boolean;
  }>;
  projects: Array<{
    id: string;
    name: string;
    archivedAt: Date;
    workspaceCount: number;
    shared: boolean;
    canUnarchive: boolean;
  }>;
}

const byArchivedAtDesc = (a: { archivedAt: Date }, b: { archivedAt: Date }) =>
  b.archivedAt.getTime() - a.archivedAt.getTime();

export async function listArchived(actor: Actor): Promise<ArchivedDto> {
  const [workspacePage, projectPage] = await Promise.all([
    listWorkspaces(actor, { archived: true, limit: ARCHIVED_LIST_LIMIT }),
    listProjects(actor, { archived: true, limit: ARCHIVED_LIST_LIMIT }),
  ]);

  // The owner always may; for shared workspaces the right comes from the
  // person's workspace or project role (at most ARCHIVED_LIST_LIMIT lookups).
  const workspaces = await Promise.all(
    workspacePage.items.map(async (w) => {
      const own = w.ownerId === actor.userId;
      const canUnarchive = own
        ? true
        : Boolean((await resolveWorkspaceRole(actor.userId, w.id))?.capabilities.has("workspace.archive"));
      return {
        id: w.id,
        title: w.title,
        archivedAt: w.archivedAt!,
        projectName: w.project?.name ?? null,
        shared: !own,
        canUnarchive,
      };
    })
  );

  const projects = projectPage.items.map((p) => ({
    id: p.id,
    name: p.name,
    archivedAt: p.archivedAt!,
    workspaceCount: p._count.workspaces,
    shared: p.ownerId !== actor.userId,
    canUnarchive: p.capabilities.includes("workspace.archive"),
  }));

  return {
    workspaces: workspaces.sort(byArchivedAtDesc),
    projects: projects.sort(byArchivedAtDesc),
  };
}
