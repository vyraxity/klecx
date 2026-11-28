/**
 * @jest-environment node
 */
/**
 * Pre-10.6 fix PR 3: the top bar's page comes from the URL, Settings' back
 * link target, and the server count behind the "Comments & Asks" badge.
 */
import { db } from "@/server/db/client";
import type { Actor } from "@/server/auth/session";
import { countWorkspaceAnnotations, listWorkspaceAnnotations } from "@/server/services/annotation";
import { settingsReturnHref, topbarPage } from "@/lib/layout/topbar-page";

describe("topbarPage()", () => {
  test("reads the page from the URL only", () => {
    expect(topbarPage("/workspaces/abc")).toEqual({ kind: "workspace", id: "abc" });
    expect(topbarPage("/workspaces/abc/")).toEqual({ kind: "workspace", id: "abc" });
    expect(topbarPage("/projects/p1")).toEqual({ kind: "project", id: "p1" });
    expect(topbarPage("/settings")).toEqual({ kind: "settings" });
    expect(topbarPage("/settings/profile")).toEqual({ kind: "settings" });
    expect(topbarPage("/workspaces")).toEqual({ kind: "home" });
    expect(topbarPage("/something-else")).toEqual({ kind: "other" });
    expect(topbarPage(null)).toEqual({ kind: "other" });
    // Not a settings page just because it starts with the same letters.
    expect(topbarPage("/settingsx")).toEqual({ kind: "other" });
  });
});

describe("settingsReturnHref()", () => {
  test("keeps the page and its query string, never a Settings page", () => {
    expect(settingsReturnHref("/workspaces/abc", "thread=a%3A1")).toBe("/workspaces/abc?thread=a%3A1");
    expect(settingsReturnHref("/projects/p1", "")).toBe("/projects/p1");
    expect(settingsReturnHref("/settings/profile", "")).toBeNull();
    expect(settingsReturnHref("//evil.example", "")).toBeNull();
    expect(settingsReturnHref("https://evil.example/x", "")).toBeNull();
  });
});

describe("countWorkspaceAnnotations()", () => {
  const sfx = Date.now().toString(36);
  const ownerId = `cnt_owner_${sfx}`;
  const memberId = `cnt_member_${sfx}`;
  const strangerId = `cnt_stranger_${sfx}`;
  const actor = (id: string): Actor => ({ userId: id, email: `${id}@example.com`, name: id }) as Actor;
  let workspaceId = "";

  beforeAll(async () => {
    for (const id of [ownerId, memberId, strangerId]) {
      await db.user.create({ data: { id, email: `${id}@example.com`, name: id } });
    }
    workspaceId = (await db.workspace.create({ data: { ownerId, title: "Count WS" } })).id;
    await db.workspaceMember.create({
      data: { workspaceId, userId: memberId, role: "COMMENTER", canAsk: true, invitedById: ownerId },
    });
    const response = await db.response.create({
      data: { workspaceId, createdById: ownerId, prompt: "p", kind: "TEXT", origin: "DIRECT" },
    });
    const version = await db.responseVersion.create({
      data: {
        responseId: response.id,
        number: 1,
        status: "COMPLETE",
        content: "x marks the spot",
        modelKey: "text-economy",
        providerModelId: "test",
        promptVersion: "v1",
        createdById: ownerId,
      },
    });
    const base = {
      workspaceId,
      responseId: response.id,
      versionId: version.id,
      anchorExact: "x",
      anchorPrefix: "",
      anchorSuffix: "",
      visibility: "WORKSPACE" as const,
    };
    const make = async (
      data: Partial<{ kind: "COMMENT" | "ASK"; questionState: "NONE" | "QUEUED" | "ANSWERING" | "ANSWERED" | "CANCELLED" | "FAILED"; createdById: string; visibility: "WORKSPACE" | "PRIVATE"; deletedAt: Date }>,
      answered = false
    ) => {
      const a = await db.annotation.create({
        data: { ...base, kind: "COMMENT", createdById: ownerId, ...data },
      });
      await db.annotationMessage.create({ data: { annotationId: a.id, role: "USER", content: "q", authorId: a.createdById } });
      if (answered) {
        await db.annotationMessage.create({ data: { annotationId: a.id, role: "ASSISTANT", content: "a" } });
      }
    };
    await make({ kind: "COMMENT" }); // counted
    await make({ kind: "COMMENT", deletedAt: new Date() }); // deleted
    await make({ kind: "ASK", questionState: "NONE" }, true); // asked now
    await make({ kind: "ASK", questionState: "ANSWERED" }, true); // from the queue
    await make({ kind: "ASK", questionState: "FAILED" }); // not answered: still listed
    await make({ kind: "ASK", questionState: "QUEUED" }); // waiting: queue popover
    await make({ kind: "ASK", questionState: "ANSWERING" }); // being answered
    await make({ kind: "ASK", questionState: "CANCELLED" }); // removed from the queue
    // The owner's private Ask: only the owner sees it.
    await make({ kind: "ASK", questionState: "NONE", visibility: "PRIVATE" }, true);
  });

  afterAll(async () => {
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [ownerId, memberId, strangerId] } } });
  });

  test("counts comments and Asks like the panel lists them, with the viewer's visibility", async () => {
    expect(await countWorkspaceAnnotations(actor(ownerId), workspaceId)).toEqual({ comments: 1, asks: 4, total: 5 });
    expect(await countWorkspaceAnnotations(actor(memberId), workspaceId)).toEqual({ comments: 1, asks: 3, total: 4 });
  });

  test("agrees with the list the panel filters", async () => {
    const rows = await listWorkspaceAnnotations(actor(ownerId), workspaceId);
    const answered = (r: (typeof rows)[number]) => r.messages.some((m) => m.role === "ASSISTANT");
    const listed = rows.filter(
      (r) =>
        r.kind === "COMMENT" ||
        answered(r) ||
        !["QUEUED", "ANSWERING", "CANCELLED"].includes(r.questionState)
    );
    expect(listed).toHaveLength(5);
  });

  test("someone outside the workspace gets 404", async () => {
    await expect(countWorkspaceAnnotations(actor(strangerId), workspaceId)).rejects.toMatchObject({ status: 404 });
  });
});
