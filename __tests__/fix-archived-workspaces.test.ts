/**
 * @jest-environment node
 */
/**
 * Pre-10.6 fix PR 8 (owner, 2026-11-28): archived workspaces and projects can
 * be found and taken out of the archive (Settings → Deleted & archived,
 * Archived tab). Also: `PATCH { archived: false }` used to fail with 409
 * because the rename check ran first and refuses archived items.
 */
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { listArchived } from "@/server/services/archived";
import { updateWorkspace, listWorkspaces } from "@/server/services/workspace";
import { updateProject } from "@/server/services/project";
import { GET as archivedRoute } from "@/app/api/v1/me/archived/route";
import { deletedPageTab } from "@/lib/settings/deleted-tabs";
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
const ids = {
  owner: `ar_owner_${sfx}`,
  admin: `ar_admin_${sfx}`,
  editor: `ar_editor_${sfx}`,
  stranger: `ar_stranger_${sfx}`,
};
const actorFor = (id: string): Actor =>
  ({ userId: id, email: `${id}@example.com`, role: "USER", sessionId: `s_${id}` }) as Actor;
const owner = actorFor(ids.owner);

beforeAll(async () => {
  for (const id of Object.values(ids)) {
    await db.user.create({ data: { id, email: `${id}@example.com`, name: id, emailVerified: true } });
  }
});

async function cleanup() {
  await db.activityLog.deleteMany({ where: { actorId: { in: Object.values(ids) } } });
  await db.workspace.deleteMany({ where: { ownerId: ids.owner } });
  await db.project.deleteMany({ where: { ownerId: ids.owner } });
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
});

describe("taking things out of the archive", () => {
  test("a workspace's owner unarchives it (it used to fail with 409)", async () => {
    const ws = await db.workspace.create({ data: { ownerId: ids.owner, title: "W", archivedAt: new Date() } });
    const updated = await updateWorkspace(owner, ws.id, { archived: false });
    expect(updated.archivedAt).toBeNull();
    expect(
      await db.activityLog.count({ where: { workspaceId: ws.id, action: "workspace.unarchived" } })
    ).toBe(1);
    // It's back in the person's list.
    const list = await listWorkspaces(owner, {});
    expect(list.items.map((w) => w.id)).toContain(ws.id);
  });

  test("a project's owner unarchives it", async () => {
    const p = await db.project.create({ data: { ownerId: ids.owner, name: "P", archivedAt: new Date() } });
    const updated = await updateProject(owner, p.id, { archived: false });
    expect(updated.archivedAt).toBeNull();
  });

  test("renaming an archived item is still refused, unless the same request unarchives it", async () => {
    const ws = await db.workspace.create({ data: { ownerId: ids.owner, title: "W", archivedAt: new Date() } });
    await expect(updateWorkspace(owner, ws.id, { title: "New" })).rejects.toMatchObject({ status: 409 });
    const both = await updateWorkspace(owner, ws.id, { title: "New", archived: false });
    expect(both).toMatchObject({ title: "New", archivedAt: null });

    const p = await db.project.create({ data: { ownerId: ids.owner, name: "P", archivedAt: new Date() } });
    await expect(updateProject(owner, p.id, { name: "Q" })).rejects.toMatchObject({ status: 409 });
  });

  test("an admin member may unarchive, an editor may not, a stranger gets 404", async () => {
    const ws = await db.workspace.create({ data: { ownerId: ids.owner, title: "W", archivedAt: new Date() } });
    await db.workspaceMember.createMany({
      data: [
        { workspaceId: ws.id, userId: ids.admin, role: "ADMIN", invitedById: ids.owner },
        { workspaceId: ws.id, userId: ids.editor, role: "EDITOR", invitedById: ids.owner },
      ],
    });
    await expect(updateWorkspace(actorFor(ids.stranger), ws.id, { archived: false })).rejects.toMatchObject({
      status: 404,
    });
    await expect(updateWorkspace(actorFor(ids.editor), ws.id, { archived: false })).rejects.toMatchObject({
      status: 403,
    });
    const done = await updateWorkspace(actorFor(ids.admin), ws.id, { archived: false });
    expect(done.archivedAt).toBeNull();
  });
});

describe("listArchived", () => {
  test("lists archived workspaces and projects the person can open, newest first, with who may unarchive", async () => {
    const project = await db.project.create({ data: { ownerId: ids.owner, name: "Live project" } });
    const older = await db.workspace.create({
      data: { ownerId: ids.owner, title: "Older", archivedAt: new Date(Date.now() - 60_000), projectId: project.id },
    });
    const newer = await db.workspace.create({ data: { ownerId: ids.owner, title: "Newer", archivedAt: new Date() } });
    await db.workspace.create({ data: { ownerId: ids.owner, title: "Alive" } });
    await db.workspace.create({
      data: { ownerId: ids.owner, title: "Deleted", archivedAt: new Date(), deletedAt: new Date() },
    });
    const archivedProject = await db.project.create({
      data: { ownerId: ids.owner, name: "Shelved", archivedAt: new Date() },
    });
    await db.workspace.create({ data: { ownerId: ids.owner, title: "Inside", projectId: archivedProject.id } });

    const mine = await listArchived(owner);
    expect(mine.workspaces.map((w) => w.title)).toEqual(["Newer", "Older"]);
    expect(mine.workspaces.find((w) => w.id === older.id)).toMatchObject({
      projectName: "Live project",
      shared: false,
      canUnarchive: true,
    });
    expect(mine.workspaces.find((w) => w.id === newer.id)!.projectName).toBeNull();
    expect(mine.projects).toEqual([
      expect.objectContaining({ id: archivedProject.id, name: "Shelved", workspaceCount: 1, canUnarchive: true }),
    ]);

    // A member sees the shared one; only an admin may take it out.
    await db.workspaceMember.createMany({
      data: [
        { workspaceId: newer.id, userId: ids.admin, role: "ADMIN", invitedById: ids.owner },
        { workspaceId: newer.id, userId: ids.editor, role: "EDITOR", invitedById: ids.owner },
      ],
    });
    const forAdmin = await listArchived(actorFor(ids.admin));
    expect(forAdmin.workspaces).toEqual([
      expect.objectContaining({ id: newer.id, shared: true, canUnarchive: true }),
    ]);
    const forEditor = await listArchived(actorFor(ids.editor));
    expect(forEditor.workspaces).toEqual([
      expect.objectContaining({ id: newer.id, shared: true, canUnarchive: false }),
    ]);

    // A stranger sees nothing.
    expect(await listArchived(actorFor(ids.stranger))).toEqual({ workspaces: [], projects: [] });
  });

  test("the endpoint needs a signed-in person", async () => {
    mockActor = null;
    expect((await archivedRoute(new NextRequest("http://localhost:3000/api/v1/me/archived"))).status).toBe(401);
    mockActor = owner;
    const res = await archivedRoute(new NextRequest("http://localhost:3000/api/v1/me/archived"));
    expect(res.status).toBe(200);
  });
});

describe("the page's tabs", () => {
  test("?tab=archived opens the Archived tab; anything else the Deleted one", () => {
    expect(deletedPageTab("archived")).toBe("archived");
    expect(deletedPageTab(["archived", "x"])).toBe("archived");
    expect(deletedPageTab("deleted")).toBe("deleted");
    expect(deletedPageTab("nope")).toBe("deleted");
    expect(deletedPageTab(undefined)).toBe("deleted");
  });
});
