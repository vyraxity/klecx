/**
 * @jest-environment node
 */
/**
 * Pre-10.6 fix PR 6 (owner, 2026-11-27): "Recently deleted". Owners see and
 * restore their deleted workspaces and projects for 30 days; a workspace
 * whose project is also deleted comes back without it; a deleted project's
 * workspaces show as standalone meanwhile.
 */
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import {
  listRecentlyDeleted,
  restoreDeletedProject,
  restoreDeletedWorkspace,
} from "@/server/services/recently-deleted";
import { deleteWorkspace, listWorkspaces } from "@/server/services/workspace";
import { deleteProject } from "@/server/services/project";
import { GET as listRoute } from "@/app/api/v1/me/recently-deleted/route";
import type { Actor } from "@/server/auth/session";

jest.mock("../server/email/send", () => ({
  sendEmail: jest.fn(async () => ({ success: true })),
  maskEmail: (e: string) => e,
}));

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => {
  const actual = jest.requireActual("../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});

const sfx = `${Date.now()}`.slice(-7);
const ids = { owner: `rd_owner_${sfx}`, member: `rd_member_${sfx}`, stranger: `rd_stranger_${sfx}` };
const actorFor = (id: string): Actor => ({ userId: id, email: `${id}@example.com`, role: "USER", sessionId: `s_${id}` }) as Actor;
const DAY = 24 * 60 * 60 * 1000;

async function workspace(title: string, extra: { projectId?: string; deletedAt?: Date } = {}) {
  return db.workspace.create({ data: { ownerId: ids.owner, title, ...extra } });
}

beforeAll(async () => {
  for (const id of Object.values(ids)) {
    await db.user.create({ data: { id, email: `${id}@example.com`, name: id, emailVerified: true } });
  }
});

afterAll(async () => {
  await db.memberLimitGrace.deleteMany({ where: { ownerId: ids.owner } });
  await db.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } });
  await db.workspace.deleteMany({ where: { ownerId: ids.owner } });
  await db.project.deleteMany({ where: { ownerId: ids.owner } });
  await db.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
});

beforeEach(async () => {
  await db.workspace.deleteMany({ where: { ownerId: ids.owner } });
  await db.project.deleteMany({ where: { ownerId: ids.owner } });
  await db.memberLimitGrace.deleteMany({ where: { ownerId: ids.owner } });
});

describe("Recently deleted", () => {
  test("lists the owner's deleted workspaces and projects of the last 30 days, with days left", async () => {
    const recent = await workspace("Recent", { deletedAt: new Date(Date.now() - 2 * DAY) });
    await workspace("Too old", { deletedAt: new Date(Date.now() - 31 * DAY) });
    await workspace("Alive");
    const project = await db.project.create({
      data: { ownerId: ids.owner, name: "Gone project", deletedAt: new Date(Date.now() - DAY) },
    });
    await workspace("In gone project", { projectId: project.id, deletedAt: new Date() });

    const list = await listRecentlyDeleted(actorFor(ids.owner));
    expect(list.retentionDays).toBe(30);
    expect(list.workspaces.map((w) => w.title)).toEqual(["In gone project", "Recent"]);
    const recentRow = list.workspaces.find((w) => w.id === recent.id)!;
    expect(recentRow.daysLeft).toBe(27);
    expect(list.workspaces[0]!.deletedProjectName).toBe("Gone project");
    expect(list.projects.map((p) => p.name)).toEqual(["Gone project"]);

    // Nobody else sees them.
    const forStranger = await listRecentlyDeleted(actorFor(ids.stranger));
    expect(forStranger.workspaces).toEqual([]);
    expect(forStranger.projects).toEqual([]);
  });

  test("restores a workspace for its owner only, within 30 days", async () => {
    const ws = await workspace("Restore me");
    await deleteWorkspace(actorFor(ids.owner), ws.id);

    await expect(restoreDeletedWorkspace(actorFor(ids.stranger), ws.id)).rejects.toMatchObject({ status: 404 });
    const restored = await restoreDeletedWorkspace(actorFor(ids.owner), ws.id);
    expect(restored.deletedAt).toBeNull();
    expect(await db.activityLog.count({ where: { workspaceId: ws.id, action: "workspace.restored" } })).toBe(1);

    const old = await workspace("Old", { deletedAt: new Date(Date.now() - 31 * DAY) });
    await expect(restoreDeletedWorkspace(actorFor(ids.owner), old.id)).rejects.toMatchObject({
      status: 409,
      code: "restore_expired",
    });
  });

  test("a workspace whose project is also deleted comes back without a project", async () => {
    const project = await db.project.create({ data: { ownerId: ids.owner, name: "P" } });
    const ws = await workspace("Inside", { projectId: project.id });
    await deleteWorkspace(actorFor(ids.owner), ws.id);
    await deleteProject(actorFor(ids.owner), project.id);

    const restored = await restoreDeletedWorkspace(actorFor(ids.owner), ws.id);
    expect(restored.projectId).toBeNull();
  });

  test("restores a project for its owner only; its workspaces show under it again", async () => {
    const project = await db.project.create({ data: { ownerId: ids.owner, name: "Proj" } });
    const ws = await workspace("Kept", { projectId: project.id });
    await deleteProject(actorFor(ids.owner), project.id);

    // Meanwhile the workspace isn't deleted and shows as standalone.
    const during = await listWorkspaces(actorFor(ids.owner), {});
    const row = during.items.find((w) => w.id === ws.id)!;
    expect(row.projectId).toBeNull();
    expect(row.project).toBeNull();

    await expect(restoreDeletedProject(actorFor(ids.stranger), project.id)).rejects.toMatchObject({ status: 404 });
    const restored = await restoreDeletedProject(actorFor(ids.owner), project.id);
    expect(restored.deletedAt).toBeNull();

    const after = await listWorkspaces(actorFor(ids.owner), {});
    expect(after.items.find((w) => w.id === ws.id)!.projectId).toBe(project.id);
  });

  test("restoring a workspace with members that puts the owner over the limit starts the grace", async () => {
    // Free: no collaborators. The member only counts again once it's restored.
    const ws = await workspace("Shared", { deletedAt: new Date() });
    await db.workspaceMember.create({
      data: { workspaceId: ws.id, userId: ids.member, role: "EDITOR", invitedById: ids.owner },
    });
    expect(await db.memberLimitGrace.count({ where: { ownerId: ids.owner } })).toBe(0);
    await restoreDeletedWorkspace(actorFor(ids.owner), ws.id);
    const grace = await db.memberLimitGrace.findUnique({ where: { ownerId: ids.owner } });
    expect(grace?.limit).toBe(0);
  });

  test("the list needs a signed-in person", async () => {
    mockActor = null;
    const res = await listRoute(new NextRequest("http://localhost:3000/api/v1/me/recently-deleted"));
    expect(res.status).toBe(401);
    mockActor = actorFor(ids.owner);
    expect((await listRoute(new NextRequest("http://localhost:3000/api/v1/me/recently-deleted"))).status).toBe(200);
  });
});
