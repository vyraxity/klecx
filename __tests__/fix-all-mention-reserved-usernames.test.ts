/**
 * @jest-environment node
 */
/**
 * Pre-10.6 fix PR 4 (owner, 2026-11-27): `@all` notifies everyone in the
 * workspace who can see the comment (never the author, never Klecx), anyone
 * who can comment can use it, and group-mention names are reserved.
 */
import crypto from "node:crypto";
import { db } from "@/server/db/client";
import { createAnnotation } from "@/server/services/annotation";
import { listMentionables } from "@/server/services/members";
import { resolveMentions, syncMentionsAndNotes } from "@/server/services/mentions";
import { RESERVED_FOR_GROUP_MENTIONS, validateUsernameFormat } from "@/lib/username";
import type { Actor } from "@/server/auth/session";
import type { Permission } from "@/server/authz/permissions";

const sentEmails: Array<{ template: string; to: string; data: Record<string, unknown> }> = [];
jest.mock("../server/email/send", () => ({
  sendEmail: jest.fn(async (template: string, to: string, data: Record<string, unknown>) => {
    sentEmails.push({ template, to, data });
    return { success: true };
  }),
  maskEmail: (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2"),
}));

describe("reserved group-mention usernames", () => {
  test("names kept for group mentions can't be claimed", () => {
    for (const name of ["all", "everyone", "here", "owner", "editor", "commenters", "viewer", "members", "team", "assistant", "moderator"]) {
      const result = validateUsernameFormat(name);
      expect(result.valid).toBe(false);
    }
    // Already reserved before, still reserved.
    for (const name of ["klecx", "app", "admin", "bot"]) {
      expect(validateUsernameFormat(name).valid).toBe(false);
    }
    expect(validateUsernameFormat("alice_dev").valid).toBe(true);
  });

  test("the conflict script reads the same list", async () => {
    const script = await import("../scripts/list-reserved-username-conflicts.mjs");
    expect(script.readReservedGroupNames()).toEqual([...RESERVED_FOR_GROUP_MENTIONS]);
  });
});

describe("@all", () => {
  const sfx = crypto.randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  const actorFor = (key: string): Actor => ({
    userId: ids[key]!,
    email: `${key}_${sfx}@example.com`,
    role: "USER",
    sessionId: `s_${key}_${sfx}`,
    name: key,
  }) as Actor;
  let workspaceId = "";
  let versionId = "";

  const mentionNotifications = (userId: string) =>
    db.notification.findMany({ where: { userId, type: "MENTIONED" }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    for (const key of ["owner", "editor", "viewer", "nousername", "suspended", "outsider"]) {
      const user = await db.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `${key}_${sfx}@example.com`,
          name: key,
          username: key === "nousername" ? null : `${key}_${sfx}`,
        },
      });
      ids[key] = user.id;
    }
    workspaceId = (
      await db.workspace.create({
        data: {
          title: "All mention",
          ownerId: ids.owner!,
          members: {
            create: [
              { userId: ids.editor!, role: "EDITOR", invitedById: ids.owner! },
              // A viewer who can comment (the per-member switch).
              { userId: ids.viewer!, role: "VIEWER", canComment: true, invitedById: ids.owner! },
              { userId: ids.nousername!, role: "VIEWER", invitedById: ids.owner! },
              { userId: ids.suspended!, role: "EDITOR", suspendedAt: new Date(), invitedById: ids.owner! },
            ],
          },
        },
      })
    ).id;
    const response = await db.response.create({
      data: { workspaceId, createdById: ids.owner!, prompt: "p" },
    });
    versionId = (
      await db.responseVersion.create({
        data: {
          responseId: response.id,
          number: 1,
          content: "The plan has three steps and a review at the end.",
          modelKey: "text-economy",
          providerModelId: "test",
          promptVersion: "1",
          createdById: ids.owner!,
        },
      })
    ).id;
  });

  beforeEach(() => {
    sentEmails.length = 0;
  });

  afterAll(async () => {
    await db.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } });
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  });

  test("notifies every active member but the author, not suspended people or outsiders", async () => {
    const annot = await createAnnotation(actorFor("viewer"), versionId, {
      kind: "COMMENT",
      visibility: "PRIVATE",
      anchor: { exact: "three steps", prefix: "", suffix: "" },
      text: "@all please review this before Friday",
    });
    // A mention makes the comment visible to the workspace.
    expect(annot.visibility).toBe("WORKSPACE");

    for (const key of ["owner", "editor", "nousername"]) {
      const notes = await mentionNotifications(ids[key]!);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.payload).toMatchObject({ everyone: true });
    }
    for (const key of ["viewer", "suspended", "outsider"]) {
      expect(await mentionNotifications(ids[key]!)).toHaveLength(0);
    }

    // One `@all` row, plus a row for each person it reached; never Klecx.
    const rows = await db.annotationMention.findMany({ where: { message: { annotationId: annot.id } } });
    expect(rows.filter((r) => r.isAll)).toHaveLength(1);
    expect(rows.some((r) => r.isKlecx)).toBe(false);
    expect(new Set(rows.filter((r) => r.userId).map((r) => r.userId))).toEqual(
      new Set([ids.owner, ids.editor, ids.nousername])
    );
    // No Klecx note either.
    expect(await db.workspaceNote.count({ where: { annotationId: annot.id } })).toBe(0);

    // The email says everyone was mentioned.
    const email = sentEmails.find((e) => e.template === "mentioned" && e.to === `editor_${sfx}@example.com`);
    expect(email?.data).toMatchObject({ everyone: true });
  });

  test("someone also mentioned by name is told they were mentioned", async () => {
    await createAnnotation(actorFor("owner"), versionId, {
      kind: "COMMENT",
      anchor: { exact: "a review", prefix: "", suffix: "" },
      text: `@all and especially @editor_${sfx}`,
    });
    const editorNotes = await mentionNotifications(ids.editor!);
    expect(editorNotes.at(-1)!.payload).toMatchObject({ everyone: false });
    const viewerNotes = await mentionNotifications(ids.viewer!);
    expect(viewerNotes.at(-1)!.payload).toMatchObject({ everyone: true });
    // The author is never notified.
    expect(await mentionNotifications(ids.owner!)).toHaveLength(1);
  });

  test("without the right to comment, or in a private thread, @all reaches nobody", async () => {
    const annot = await createAnnotation(actorFor("owner"), versionId, {
      kind: "COMMENT",
      anchor: { exact: "the end", prefix: "", suffix: "" },
      text: "Base comment",
    });
    const base = {
      workspaceId,
      annotationId: annot.id,
      text: "@all have a look",
      anchorExact: "the end",
      actor: actorFor("editor"),
      currentVisibility: "WORKSPACE" as const,
      isNewMessage: true,
    };
    const message = await db.annotationMessage.create({
      data: { annotationId: annot.id, role: "USER", content: base.text, authorId: ids.editor! },
    });

    const askOnly = new Set<Permission>(["workspace.read", "workspace.ask"]);
    const noComment = await syncMentionsAndNotes(db, {
      ...base,
      messageId: message.id,
      capabilities: askOnly,
      canShare: true,
    });
    expect(noComment.all).toBe(false);
    expect(noComment.pendingNotifications.userIds).toEqual([]);

    const canComment = new Set<Permission>(["workspace.read", "workspace.comment"]);
    const privateThread = await syncMentionsAndNotes(db, {
      ...base,
      messageId: message.id,
      capabilities: canComment,
      canShare: false,
    });
    expect(privateThread.all).toBe(false);
    expect(privateThread.pendingNotifications.userIds).toEqual([]);
  });

  test("resolveMentions keeps @all apart from people and Klecx", async () => {
    const resolved = await resolveMentions(workspaceId, "@all @klecx");
    expect(resolved.all).toBe(true);
    expect(resolved.klecx).toBe(true);
    expect(resolved.userIds).toEqual([]);
    expect(new Set(resolved.allUserIds)).toEqual(new Set([ids.owner, ids.editor, ids.viewer, ids.nousername]));
  });

  test("the mention list offers @all first, with the number of people, to people who can comment", async () => {
    const forViewer = await listMentionables(actorFor("viewer"), workspaceId, "");
    expect(forViewer[0]).toEqual({ kind: "all", count: 3 });
    expect((await listMentionables(actorFor("viewer"), workspaceId, "ev"))[0]).toEqual({ kind: "all", count: 3 });
    expect((await listMentionables(actorFor("viewer"), workspaceId, "edi")).some((i) => i.kind === "all")).toBe(false);

    // A viewer without the comment switch doesn't get it.
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: ids.nousername! } },
      data: { canComment: false },
    });
    const forReader = await listMentionables(actorFor("nousername"), workspaceId, "");
    expect(forReader.some((i) => i.kind === "all")).toBe(false);
  });

  test("someone outside the workspace can't list mentionables (404)", async () => {
    await expect(listMentionables(actorFor("outsider"), workspaceId, "")).rejects.toMatchObject({ status: 404 });
  });
});
