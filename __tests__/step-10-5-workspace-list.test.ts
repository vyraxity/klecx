/**
 * @jest-environment node
 */
import { db } from "@/server/db/client";
import { listWorkspaces } from "@/server/services/workspace";
import type { Actor } from "@/server/auth/session";

/**
 * Step 10.5: the workspace list finds memberships and projects first, then
 * lists by index (no scan of every workspace). Same visibility as before:
 * own workspaces, shared ones, those in a project the person owns or belongs
 * to (not deleted), never someone else's.
 */
describe("Step 10.5 — workspace list visibility after the query rewrite", () => {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const id = (s: string) => `wl_${s}_${unique}`;
  let me: Actor;

  beforeAll(async () => {
    for (const u of ["me", "other", "third"]) {
      await db.user.create({ data: { id: id(u), name: u, email: `${id(u)}@example.com`, emailVerified: true } });
    }
    me = { userId: id("me"), email: `${id("me")}@example.com`, role: "USER", sessionId: "s" };
    const other = id("other");

    await db.project.create({ data: { id: id("myProject"), ownerId: me.userId, name: "Mine" } });
    await db.project.create({ data: { id: id("sharedProject"), ownerId: other, name: "Shared" } });
    await db.project.create({ data: { id: id("deletedProject"), ownerId: other, name: "Gone", deletedAt: new Date() } });
    await db.projectMember.create({ data: { projectId: id("sharedProject"), userId: me.userId, role: "VIEWER", invitedById: other } });
    await db.projectMember.create({ data: { projectId: id("deletedProject"), userId: me.userId, role: "VIEWER", invitedById: other } });

    const ws = (key: string, ownerId: string, extra: Record<string, unknown> = {}) =>
      db.workspace.create({ data: { id: id(key), ownerId, title: key, ...extra } });
    await ws("own", me.userId);
    await ws("ownDeleted", me.userId, { deletedAt: new Date() });
    await ws("ownArchived", me.userId, { archivedAt: new Date() });
    await ws("shared", other);
    await ws("inMyProject", other, { projectId: id("myProject") });
    await ws("inSharedProject", other, { projectId: id("sharedProject") });
    await ws("inDeletedProject", other, { projectId: id("deletedProject") });
    await ws("stranger", other);
    await db.workspaceMember.create({ data: { workspaceId: id("shared"), userId: me.userId, role: "VIEWER", invitedById: other } });
    await db.workspaceMember.create({ data: { workspaceId: id("shared"), userId: id("third"), role: "EDITOR", invitedById: other } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("lists exactly the workspaces the person can open, with member counts", async () => {
    const page = await listWorkspaces(me, { limit: 50 });
    const titles = page.items.map((w) => w.title).sort();
    expect(titles).toEqual(["inMyProject", "inSharedProject", "own", "shared"]);
    const shared = page.items.find((w) => w.title === "shared")!;
    expect(shared._count.members).toBe(2);
    expect(page.items.find((w) => w.title === "own")!._count.members).toBe(0);
  });

  it("archived view and search still apply", async () => {
    expect((await listWorkspaces(me, { archived: true, limit: 50 })).items.map((w) => w.title)).toEqual(["ownArchived"]);
    expect((await listWorkspaces(me, { q: "SHARED", limit: 50 })).items.map((w) => w.title).sort()).toEqual(["inSharedProject", "shared"]);
  });

  it("a stranger sees none of them", async () => {
    const stranger: Actor = { userId: id("third"), email: "x@example.com", role: "USER", sessionId: "s" };
    expect((await listWorkspaces(stranger, { limit: 50 })).items.map((w) => w.title)).toEqual(["shared"]);
  });
});
