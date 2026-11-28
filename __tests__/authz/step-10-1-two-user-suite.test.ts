/**
 * @jest-environment node
 *
 * Step 10.1 — two-user authorization regression suite (OWASP API1: BOLA).
 *
 * User A owns a full world (project, workspace, responses, versions, edits,
 * documents, annotations, notes, files, shares, notifications, sessions,
 * invitations, transfers, generations, exports, sign-in methods). User B is a
 * stranger. Every endpoint that takes an id is called as B with A's id and
 * must answer 404 (403 only where noted, e.g. admin-only routes), never 2xx,
 * and A's data must be unchanged afterwards.
 *
 * EVERY NEW ENDPOINT THAT TAKES AN ID MUST ADD ITS ROW to `ROWS` below: the
 * coverage test at the end fails for any `app/api/v1/**\/[param]/route.ts`
 * method that has no row (or isn't listed in `NOT_ID_SCOPED` with a reason).
 */
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { setStorageProvider } from "@/server/storage";
import { MockStorageProvider } from "@/server/storage/mock";
import { resetInMemoryRateLimits } from "@/server/http/rate-limit";
import { hashShareToken } from "@/server/services/share";
import type { Actor } from "@/server/auth/session";

let mockActor: Actor | null = null;
jest.mock("../../server/auth/session", () => {
  const actual = jest.requireActual("../../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});
jest.mock("../../server/email/send", () => {
  const actual = jest.requireActual("../../server/email/send");
  return { ...actual, sendEmail: jest.fn(async () => ({ id: "mock" })) };
});

const sfx = `${Date.now()}`.slice(-7);
const A = { id: `az_a_${sfx}`, email: `az_a_${sfx}@example.com` }; // owner of everything
const B = { id: `az_b_${sfx}`, email: `az_b_${sfx}@example.com` }; // stranger
const C = { id: `az_c_${sfx}`, email: `az_c_${sfx}@example.com` }; // A's collaborator
const USERS = [A, B, C];
const uid = () => crypto.randomUUID();

const ID = {
  project: uid(),
  workspace: uid(),
  response: uid(),
  version: uid(),
  version2: uid(),
  annotation: uid(),
  message: uid(),
  note: uid(),
  attachment: uid(),
  document: uid(),
  share: uid(),
  notification: uid(),
  sessionA: `azs_a_${sfx}`,
  sessionB: `azs_b_${sfx}`,
  invitationW: uid(),
  invitationP: uid(),
  transfer: uid(),
  generation: uid(),
  export: uid(),
};

const asUser = (u: { id: string; email: string }, sessionId = `azs_${u.id}`) => {
  mockActor = { userId: u.id, email: u.email, role: "USER", sessionId } as Actor;
};

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

type Row = {
  /** Route file under app/api/v1, e.g. "workspaces/[id]". */
  route: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: () => Record<string, string>;
  query?: string;
  body?: () => unknown;
  /** Allowed statuses for the stranger (default 404). */
  expect?: number[];
};

// ---------------------------------------------------------------------------
// One row per method of every id-scoped endpoint (and the body-id ones below).
// ---------------------------------------------------------------------------
const anchor = { exact: "Raft is", prefix: "", suffix: "" };
const ROWS: Row[] = [
  // Workspaces
  { route: "workspaces/[id]", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]", method: "PATCH", params: () => ({ id: ID.workspace }), body: () => ({ title: "Hijacked" }) },
  { route: "workspaces/[id]", method: "DELETE", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/restore", method: "POST", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/activity", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/annotations", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/annotations", method: "GET", params: () => ({ id: ID.workspace }), query: "?summary=1" },
  { route: "workspaces/[id]/attachments", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/attachments/init", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ name: "x.txt", mime: "text/plain", bytes: 10 }) },
  { route: "workspaces/[id]/attachments/link", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ url: "https://example.com/" }) },
  { route: "workspaces/[id]/documents", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ attachmentId: ID.attachment }) },
  { route: "workspaces/[id]/export", method: "GET", params: () => ({ id: ID.workspace }), query: "?format=md" },
  { route: "workspaces/[id]/generations", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ idempotencyKey: `idem-${sfx}`, prompt: "hello" }) },
  { route: "workspaces/[id]/invitations", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/invitations", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ emailOrUsername: B.email, role: "EDITOR" }) },
  { route: "workspaces/[id]/invitations/[inviteId]", method: "DELETE", params: () => ({ id: ID.workspace, inviteId: ID.invitationW }) },
  { route: "workspaces/[id]/invitations/[inviteId]/resend", method: "POST", params: () => ({ id: ID.workspace, inviteId: ID.invitationW }) },
  { route: "workspaces/[id]/members", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/members/[userId]", method: "PATCH", params: () => ({ id: ID.workspace, userId: C.id }), body: () => ({ role: "VIEWER" }) },
  { route: "workspaces/[id]/members/[userId]", method: "DELETE", params: () => ({ id: ID.workspace, userId: C.id }) },
  { route: "workspaces/[id]/mentionables", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/notes", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/questions", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/questions/run", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ idempotencyKey: `idem-q-${sfx}` }) },
  { route: "workspaces/[id]/questions/batches/[generationId]", method: "GET", params: () => ({ id: ID.workspace, generationId: ID.generation }) },
  { route: "workspaces/[id]/responses", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/shares", method: "GET", params: () => ({ id: ID.workspace }) },
  { route: "workspaces/[id]/transfer-check", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ toUserId: B.id }) },
  { route: "workspaces/[id]/transfer-ownership", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ toUserId: B.id, confirm: "TRANSFER" }) },
  { route: "workspaces/[id]/transfer-ownership", method: "POST", params: () => ({ id: ID.workspace }), body: () => ({ toUserId: C.id, confirm: "TRANSFER" }) },

  // Projects
  { route: "projects/[id]", method: "GET", params: () => ({ id: ID.project }) },
  { route: "projects/[id]", method: "PATCH", params: () => ({ id: ID.project }), body: () => ({ name: "Hijacked" }) },
  { route: "projects/[id]", method: "DELETE", params: () => ({ id: ID.project }) },
  { route: "projects/[id]/restore", method: "POST", params: () => ({ id: ID.project }) },
  { route: "projects/[id]/activity", method: "GET", params: () => ({ id: ID.project }) },
  { route: "projects/[id]/invitations", method: "GET", params: () => ({ id: ID.project }) },
  { route: "projects/[id]/invitations", method: "POST", params: () => ({ id: ID.project }), body: () => ({ emailOrUsername: B.email, role: "EDITOR" }) },
  { route: "projects/[id]/invitations/[inviteId]", method: "DELETE", params: () => ({ id: ID.project, inviteId: ID.invitationP }) },
  { route: "projects/[id]/invitations/[inviteId]/resend", method: "POST", params: () => ({ id: ID.project, inviteId: ID.invitationP }) },
  { route: "projects/[id]/members", method: "GET", params: () => ({ id: ID.project }) },
  { route: "projects/[id]/members/[userId]", method: "PATCH", params: () => ({ id: ID.project, userId: C.id }), body: () => ({ role: "VIEWER" }) },
  { route: "projects/[id]/members/[userId]", method: "DELETE", params: () => ({ id: ID.project, userId: C.id }) },
  { route: "projects/[id]/movable-workspaces", method: "GET", params: () => ({ id: ID.project }) },
  { route: "projects/[id]/workspaces", method: "GET", params: () => ({ id: ID.project }) },
  { route: "projects/[id]/transfer-check", method: "POST", params: () => ({ id: ID.project }), body: () => ({ toUserId: B.id }) },
  { route: "projects/[id]/transfer-ownership", method: "POST", params: () => ({ id: ID.project }), body: () => ({ toUserId: B.id, confirm: "TRANSFER" }) },
  { route: "projects/[id]/transfer-ownership", method: "POST", params: () => ({ id: ID.project }), body: () => ({ toUserId: C.id, confirm: "TRANSFER" }) },

  // Responses, versions, edits
  { route: "responses/[id]/active-version", method: "PUT", params: () => ({ id: ID.response }), body: () => ({ versionId: ID.version2 }) },
  { route: "responses/[id]/annotations", method: "GET", params: () => ({ id: ID.response }) },
  { route: "responses/[id]/edits", method: "POST", params: () => ({ id: ID.response }), body: () => ({ content: "Hijacked" }) },
  { route: "responses/[id]/export", method: "GET", params: () => ({ id: ID.response }), query: "?format=md" },
  { route: "responses/[id]/regenerate", method: "POST", params: () => ({ id: ID.response }), body: () => ({ idempotencyKey: `idem-r-${sfx}` }) },
  { route: "responses/[id]/versions", method: "GET", params: () => ({ id: ID.response }) },
  { route: "responses/[id]/versions", method: "PATCH", params: () => ({ id: ID.response }), body: () => ({ versionId: ID.version2 }) },
  { route: "response-versions/[id]/annotations", method: "POST", params: () => ({ id: ID.version }), body: () => ({ kind: "COMMENT", anchor, text: "hi" }) },
  { route: "response-versions/[id]/edits", method: "GET", params: () => ({ id: ID.version }) },
  { route: "response-versions/[id]/edits", method: "POST", params: () => ({ id: ID.version }), body: () => ({ content: "Hijacked" }) },
  { route: "response-versions/[id]/edits/latest", method: "DELETE", params: () => ({ id: ID.version }) },
  { route: "response-versions/[id]/review", method: "GET", params: () => ({ id: ID.version }) },
  { route: "response-versions/[id]/review", method: "POST", params: () => ({ id: ID.version }), body: () => ({ idempotencyKey: `idem-rv-${sfx}` }) },

  // Generations
  { route: "generations/[id]", method: "GET", params: () => ({ id: ID.generation }) },
  { route: "generations/[id]/cancel", method: "POST", params: () => ({ id: ID.generation }) },

  // Annotations (every depth), messages, notes
  { route: "annotations/[id]", method: "GET", params: () => ({ id: ID.annotation }) },
  { route: "annotations/[id]", method: "PATCH", params: () => ({ id: ID.annotation }), body: () => ({ resolved: true }) },
  { route: "annotations/[id]", method: "DELETE", params: () => ({ id: ID.annotation }) },
  { route: "annotations/[id]/answer", method: "POST", params: () => ({ id: ID.annotation }), body: () => ({ idempotencyKey: `idem-a-${sfx}` }) },
  { route: "annotations/[id]/chain", method: "GET", params: () => ({ id: ID.annotation }) },
  { route: "annotations/[id]/messages", method: "POST", params: () => ({ id: ID.annotation }), body: () => ({ content: "hi" }) },
  { route: "annotations/[id]/promote", method: "POST", params: () => ({ id: ID.annotation }), body: () => ({ messageId: ID.message, target: "TIMELINE" }) },
  { route: "annotation-messages/[id]/annotations", method: "GET", params: () => ({ id: ID.message }) },
  { route: "annotation-messages/[id]/annotations", method: "POST", params: () => ({ id: ID.message }), body: () => ({ kind: "COMMENT", anchor: { exact: "Check this", prefix: "", suffix: "" }, text: "hi" }) },
  { route: "notes/[id]", method: "PATCH", params: () => ({ id: ID.note }), body: () => ({ status: "ARCHIVED" }) },
  { route: "notes/[id]", method: "DELETE", params: () => ({ id: ID.note }) },

  // Documents and revisions
  { route: "documents/[id]", method: "GET", params: () => ({ id: ID.document }) },
  { route: "documents/[id]", method: "PATCH", params: () => ({ id: ID.document }), body: () => ({ title: "Hijacked" }) },
  { route: "documents/[id]/download", method: "GET", params: () => ({ id: ID.document }) },
  { route: "documents/[id]/review", method: "GET", params: () => ({ id: ID.document }) },
  { route: "documents/[id]/review", method: "POST", params: () => ({ id: ID.document }), body: () => ({ idempotencyKey: `idem-d-${sfx}` }) },
  { route: "documents/[id]/revisions", method: "POST", params: () => ({ id: ID.document }), body: () => ({ content: "Hijacked" }) },
  { route: "documents/[id]/revisions/[rev]", method: "GET", params: () => ({ id: ID.document, rev: "1" }) },
  { route: "documents/[id]/revisions/[rev]/annotations", method: "GET", params: () => ({ id: ID.document, rev: "1" }) },
  { route: "documents/[id]/revisions/[rev]/annotations", method: "POST", params: () => ({ id: ID.document, rev: "1" }), body: () => ({ kind: "COMMENT", anchor: { exact: "Summary", prefix: "", suffix: "" }, text: "hi" }) },

  // Attachments
  { route: "attachments/[id]", method: "DELETE", params: () => ({ id: ID.attachment }) },
  { route: "attachments/[id]/complete", method: "POST", params: () => ({ id: ID.attachment }), body: () => ({}) },
  { route: "attachments/[id]/download", method: "GET", params: () => ({ id: ID.attachment }) },
  { route: "attachments/[id]/url", method: "GET", params: () => ({ id: ID.attachment }) },

  // Shares, notifications, transfers
  { route: "shares/[id]", method: "DELETE", params: () => ({ id: ID.share }) },
  { route: "notifications/[id]", method: "DELETE", params: () => ({ id: ID.notification }) },
  { route: "notifications/[id]/read", method: "POST", params: () => ({ id: ID.notification }) },
  { route: "ownership-transfers/[id]", method: "DELETE", params: () => ({ id: ID.transfer }) },
  { route: "ownership-transfers/[id]/accept", method: "POST", params: () => ({ id: ID.transfer }) },
  { route: "ownership-transfers/[id]/decline", method: "POST", params: () => ({ id: ID.transfer }) },

  // The caller's own account: A's ids are never reachable through B's /me
  { route: "me/sessions/[id]", method: "DELETE", params: () => ({ id: ID.sessionA }) },
  { route: "me/exports/[id]/download", method: "GET", params: () => ({ id: ID.export }) },
  // B has no Google sign-in; A's never shows up in B's account.
  { route: "me/linked-accounts/[provider]", method: "GET", params: () => ({ provider: "google" }) },
  { route: "me/linked-accounts/[provider]", method: "DELETE", params: () => ({ provider: "google" }), body: () => ({}) },

  // Admin-only: a normal user is refused (403, the routes are not secret).
  { route: "admin/users/[id]/suspend", method: "POST", params: () => ({ id: A.id }), body: () => ({ reason: "testing" }), expect: [403] },
  { route: "admin/users/[id]/unsuspend", method: "POST", params: () => ({ id: A.id }), expect: [403] },
  { route: "admin/users/[id]/freeze-credits", method: "POST", params: () => ({ id: A.id }), body: () => ({ reason: "testing" }), expect: [403] },
  { route: "admin/users/[id]/unfreeze-credits", method: "POST", params: () => ({ id: A.id }), expect: [403] },
  { route: "admin/users/[id]/reset-username-limit", method: "POST", params: () => ({ id: A.id }), expect: [403] },
  { route: "admin/users/[id]/purge-deleted", method: "POST", params: () => ({ id: A.id }), body: () => ({}), expect: [403] },
  { route: "admin/users/[id]/reset-two-factor", method: "POST", params: () => ({ id: A.id }), expect: [403] },
  { route: "admin/metrics", method: "GET", expect: [403] },
  { route: "admin/alerts", method: "GET", expect: [403] },
  { route: "admin/features", method: "GET", expect: [403] },
  { route: "admin/features/[key]", method: "PUT", params: () => ({ key: "ai" }), body: () => ({ enabled: false }), expect: [403] },
  { route: "admin/alerts/run", method: "POST", expect: [403] },
  { route: "admin/monitoring/test-error", method: "POST", expect: [403] },

  // Endpoints that take A's ids in the body or query instead of the path.
  { route: "shares", method: "POST", body: () => ({ workspaceId: ID.workspace, scope: "WORKSPACE" }) },
  { route: "speech", method: "POST", body: () => ({ target: { type: "RESPONSE_VERSION", id: ID.version } }) },
  { route: "speech", method: "POST", body: () => ({ target: { type: "ANNOTATION_MESSAGE", id: ID.message } }) },
  { route: "speech", method: "POST", body: () => ({ target: { type: "DOCUMENT_REVISION", id: ID.document } }) },
  { route: "speech/segment", method: "POST", body: () => ({ target: { type: "RESPONSE_VERSION", id: ID.version }, index: 0 }) },
  { route: "workspaces", method: "POST", body: () => ({ title: "Mine", projectId: ID.project }) },
  { route: "me/avatar", method: "PUT", body: () => ({ attachmentId: ID.attachment }) },
];

/** Id-scoped methods with no stranger case, and why. */
const NOT_ID_SCOPED: Record<string, string> = {
  "s/[token] GET": "public share link by secret token: tested in step-7-6-public-sharing",
};

// ---------------------------------------------------------------------------

async function cleanup() {
  const ids = USERS.map((u) => u.id);
  await db.dataExport.deleteMany({ where: { userId: { in: ids } } });
  await db.ownershipTransfer.deleteMany({ where: { fromUserId: { in: ids } } });
  await db.invitation.deleteMany({ where: { invitedById: { in: ids } } });
  await db.workspace.deleteMany({ where: { ownerId: { in: ids } } });
  await db.project.deleteMany({ where: { ownerId: { in: ids } } });
  await db.generation.deleteMany({ where: { actorId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.attachment.deleteMany({ where: { ownerId: { in: ids } } });
  await db.activityLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.account.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

/** A fingerprint of A's world: nothing a stranger does may change it. */
async function snapshot() {
  const [ws, proj, resp, versions, edits, ann, msgs, note, att, doc, revs, share, notif, sess, inv, tr, gen, members, pmembers] =
    await Promise.all([
      db.workspace.findUnique({ where: { id: ID.workspace }, select: { title: true, deletedAt: true, archivedAt: true, ownerId: true, projectId: true } }),
      db.project.findUnique({ where: { id: ID.project }, select: { name: true, deletedAt: true, archivedAt: true, ownerId: true } }),
      db.response.findUnique({ where: { id: ID.response }, select: { activeVersionId: true, deletedAt: true } }),
      db.responseVersion.count({ where: { responseId: ID.response } }),
      db.responseEdit.count({ where: { versionId: ID.version } }),
      db.annotation.findUnique({ where: { id: ID.annotation }, select: { resolvedAt: true, deletedAt: true, visibility: true } }),
      db.annotationMessage.count({ where: { annotation: { workspaceId: ID.workspace } } }),
      db.workspaceNote.findUnique({ where: { id: ID.note }, select: { status: true, deletedAt: true } }),
      db.attachment.findUnique({ where: { id: ID.attachment }, select: { status: true, deletedAt: true } }),
      db.document.findUnique({ where: { id: ID.document }, select: { title: true } }),
      db.documentRevision.count({ where: { documentId: ID.document } }),
      db.shareLink.findUnique({ where: { id: ID.share }, select: { revokedAt: true } }),
      db.notification.findUnique({ where: { id: ID.notification }, select: { status: true, dismissedAt: true } }),
      db.session.findUnique({ where: { id: ID.sessionA }, select: { id: true } }),
      db.invitation.findMany({ where: { id: { in: [ID.invitationW, ID.invitationP] } }, select: { status: true }, orderBy: { id: "asc" } }),
      db.ownershipTransfer.findUnique({ where: { id: ID.transfer }, select: { status: true } }),
      db.generation.findUnique({ where: { id: ID.generation }, select: { status: true } }),
      db.workspaceMember.findMany({ where: { workspaceId: ID.workspace }, select: { userId: true, role: true }, orderBy: { userId: "asc" } }),
      db.projectMember.findMany({ where: { projectId: ID.project }, select: { userId: true, role: true }, orderBy: { userId: "asc" } }),
    ]);
  const workspaces = await db.workspace.count({ where: { OR: [{ projectId: ID.project }, { ownerId: B.id }] } });
  const shares = await db.shareLink.count({ where: { workspaceId: ID.workspace } });
  const user = await db.user.findUnique({ where: { id: A.id }, select: { suspendedAt: true, deletedAt: true, image: true } });
  return { ws, proj, resp, versions, edits, ann, msgs, note, att, doc, revs, share, notif, sess, inv, tr, gen, members, pmembers, workspaces, shares, user };
}

let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  await cleanup();
  setStorageProvider(new MockStorageProvider());
  for (const u of USERS) {
    await db.user.create({ data: { id: u.id, email: u.email, name: `Name ${u.id}`, emailVerified: true, username: `az${u.id.slice(-9)}`.replace(/_/g, "") } });
    await createAccountWithFreeGrant(u.id);
  }
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  await db.session.create({ data: { id: ID.sessionA, userId: A.id, token: `tok_${ID.sessionA}`, expiresAt } });
  await db.session.create({ data: { id: ID.sessionB, userId: B.id, token: `tok_${ID.sessionB}`, expiresAt } });
  await db.account.create({ data: { id: `azacc_${sfx}`, userId: A.id, accountId: `google-${sfx}`, providerId: "google" } });

  await db.project.create({ data: { id: ID.project, ownerId: A.id, name: "A's project" } });
  await db.projectMember.create({ data: { projectId: ID.project, userId: C.id, role: "EDITOR", invitedById: A.id } });
  await db.workspace.create({ data: { id: ID.workspace, ownerId: A.id, title: "A's workspace", projectId: ID.project } });
  await db.workspaceMember.create({ data: { workspaceId: ID.workspace, userId: C.id, role: "EDITOR", invitedById: A.id } });

  await db.response.create({ data: { id: ID.response, workspaceId: ID.workspace, createdById: A.id, prompt: "Explain Raft" } });
  for (const [id, number] of [[ID.version, 1], [ID.version2, 2]] as const) {
    await db.responseVersion.create({
      data: { id, responseId: ID.response, number, modelKey: "text-economy", providerModelId: "x", promptVersion: "1", createdById: A.id, content: "Raft is a consensus algorithm.", status: "COMPLETE" },
    });
  }
  await db.response.update({ where: { id: ID.response }, data: { activeVersionId: ID.version } });
  await db.responseEdit.create({ data: { versionId: ID.version, revision: 1, content: "Raft is an easy consensus algorithm.", editorId: A.id } });

  await db.document.create({ data: { id: ID.document, workspaceId: ID.workspace, versionId: ID.version, title: "Summary", format: "md", createdById: A.id } });
  await db.documentRevision.create({ data: { documentId: ID.document, revision: 1, content: "# Summary\n\nFirst." } });

  await db.annotation.create({
    data: {
      id: ID.annotation, workspaceId: ID.workspace, createdById: A.id, kind: "COMMENT", versionId: ID.version, responseId: ID.response,
      anchorExact: "Raft", anchorPrefix: "", anchorSuffix: "", visibility: "WORKSPACE",
      messages: { create: { id: ID.message, role: "USER", content: "Check this @klecx remember Raft", authorId: A.id } },
    },
  });
  await db.workspaceNote.create({
    data: { id: ID.note, workspaceId: ID.workspace, annotationId: ID.annotation, messageId: ID.message, createdById: A.id, quote: "Raft", instruction: "remember Raft" },
  });

  await db.attachment.create({
    data: { id: ID.attachment, ownerId: A.id, workspaceId: ID.workspace, kind: "DOCUMENT", status: "READY", providerId: `klecx/dev/${ID.workspace}/f1`, resourceType: "raw", mime: "text/plain", bytes: 10, originalName: "notes.txt" },
  });
  await db.shareLink.create({
    data: { id: ID.share, workspaceId: ID.workspace, scope: "WORKSPACE", tokenHash: hashShareToken(`azshare_${sfx}`), tokenPrefix: "azshare", createdById: A.id },
  });
  await db.notification.create({ data: { id: ID.notification, userId: A.id, type: "MENTION", payload: {} } });
  await db.invitation.create({
    data: { id: ID.invitationW, workspaceId: ID.workspace, email: `invitee_${sfx}@example.com`, role: "EDITOR", tokenHash: `azinvw_${sfx}`, invitedById: A.id, expiresAt },
  });
  await db.invitation.create({
    data: { id: ID.invitationP, projectId: ID.project, email: `invitee_${sfx}@example.com`, role: "EDITOR", tokenHash: `azinvp_${sfx}`, invitedById: A.id, expiresAt },
  });
  await db.ownershipTransfer.create({ data: { id: ID.transfer, workspaceId: ID.workspace, fromUserId: A.id, toUserId: C.id, expiresAt } });
  await db.generation.create({
    data: { id: ID.generation, workspaceId: ID.workspace, responseId: ID.response, versionId: ID.version, actorId: A.id, billedAccountId: A.id, kind: "TEXT", status: "RUNNING", modelKey: "text-economy", providerModelId: "x", promptVersion: "1", idempotencyKey: `azgen_${sfx}` },
  });
  await db.dataExport.create({
    data: { id: ID.export, userId: A.id, status: "READY", storageId: "klecx/dev/exports/x", expiresAt: new Date(Date.now() + 86_400_000) },
  });

  before = await snapshot();
}, 60_000);

afterAll(async () => {
  setStorageProvider(null);
  await cleanup();
});

beforeEach(() => resetInMemoryRateLimits());

function loadHandler(route: string, method: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path.join(process.cwd(), "app/api/v1", route, "route.ts"));
  const handler = mod[method];
  if (typeof handler !== "function") throw new Error(`${route} has no ${method}`);
  return handler as Handler;
}

function fill(route: string, params: Record<string, string>) {
  return route.replace(/\[(\w+)\]/g, (_, k: string) => params[k] ?? `[${k}]`);
}

describe("Step 10.1 — a stranger gets 404 on every id-scoped endpoint", () => {
  test.each(ROWS.map((r, i) => [`${r.method} ${r.route} #${i}`, r] as const))("%s", async (_label, row) => {
    asUser(B, ID.sessionB);
    const params = row.params?.() ?? {};
    const req = new NextRequest(`http://localhost:3000/api/v1/${fill(row.route, params)}${row.query ?? ""}`, {
      method: row.method,
      headers: { "content-type": "application/json" },
      ...(row.body ? { body: JSON.stringify(row.body()) } : {}),
    });
    const res = await loadHandler(row.route, row.method)(req, { params: Promise.resolve(params) });
    const expected = row.expect ?? [404];
    const detail = expected.includes(res.status) ? "" : await res.text();
    if (!expected.includes(res.status)) {
      throw new Error(`expected ${expected.join("/")}, got ${res.status}: ${detail.slice(0, 400)}`);
    }
  });

  test("A's world is unchanged after every stranger request", async () => {
    expect(await snapshot()).toEqual(before);
  });

  test("the owner still reaches the same resources (the ids are real)", async () => {
    asUser(A, ID.sessionA);
    for (const [route, params] of [
      ["workspaces/[id]", { id: ID.workspace }],
      ["projects/[id]", { id: ID.project }],
      ["annotations/[id]", { id: ID.annotation }],
      ["documents/[id]", { id: ID.document }],
      ["generations/[id]", { id: ID.generation }],
      ["responses/[id]/versions", { id: ID.response }],
    ] as const) {
      const res = await loadHandler(route, "GET")(
        new NextRequest(`http://localhost:3000/api/v1/${fill(route, params)}`),
        { params: Promise.resolve(params) }
      );
      expect([route, res.status]).toEqual([route, 200]);
    }
  });
});

describe("Step 10.1 — every id-scoped endpoint has a row", () => {
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  }

  test("no [param] route method is missing from ROWS", () => {
    const root = path.join(process.cwd(), "app/api/v1");
    const covered = new Set(ROWS.map((r) => `${r.route} ${r.method}`));
    const missing: string[] = [];
    for (const file of walk(root).filter((f) => f.endsWith("route.ts"))) {
      const route = path.relative(root, path.dirname(file)).split(path.sep).join("/");
      if (!route.includes("[")) continue;
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/export (?:const|async function) (GET|POST|PUT|PATCH|DELETE)\b/g)) {
        const key = `${route} ${m[1]}`;
        if (!covered.has(key) && !NOT_ID_SCOPED[key]) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("Step 10.1 — interlude checks", () => {
  test("a suspended member can read but not change anything", async () => {
    await db.workspaceMember.updateMany({
      where: { workspaceId: ID.workspace, userId: C.id },
      data: { suspendedAt: new Date(), suspendedReason: "test" },
    });
    await db.projectMember.updateMany({
      where: { projectId: ID.project, userId: C.id },
      data: { suspendedAt: new Date(), suspendedReason: "test" },
    });
    try {
      asUser(C);
      const read = await loadHandler("workspaces/[id]", "GET")(
        new NextRequest(`http://localhost:3000/api/v1/workspaces/${ID.workspace}`),
        { params: Promise.resolve({ id: ID.workspace }) }
      );
      expect(read.status).toBe(200);
      for (const [route, method, params, body] of [
        ["responses/[id]/edits", "POST", { id: ID.response }, { content: "Changed" }],
        ["response-versions/[id]/annotations", "POST", { id: ID.version }, { kind: "COMMENT", anchor, text: "hi" }],
        ["workspaces/[id]/generations", "POST", { id: ID.workspace }, { idempotencyKey: `idem-s-${sfx}`, prompt: "hi" }],
        ["documents/[id]/revisions", "POST", { id: ID.document }, { content: "Changed" }],
      ] as const) {
        const res = await loadHandler(route, method)(
          new NextRequest(`http://localhost:3000/api/v1/${fill(route, params)}`, {
            method,
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve(params) }
        );
        expect([route, res.status]).toEqual([route, 403]);
      }
      expect(await db.responseEdit.count({ where: { versionId: ID.version } })).toBe(before.edits);
    } finally {
      await db.workspaceMember.updateMany({ where: { workspaceId: ID.workspace, userId: C.id }, data: { suspendedAt: null, suspendedReason: null } });
      await db.projectMember.updateMany({ where: { projectId: ID.project, userId: C.id }, data: { suspendedAt: null, suspendedReason: null } });
    }
  });

  test("mention spam: one author notifies one person at most 10 times per 10 minutes", async () => {
    const { sendMentionNotifications } = await import("@/server/services/mentions");
    await db.notification.deleteMany({ where: { userId: C.id } });
    for (let i = 0; i < 14; i++) {
      await sendMentionNotifications({
        workspaceId: ID.workspace,
        annotationId: ID.annotation,
        messageId: `spam-${sfx}-${i}`,
        quote: "Raft",
        excerpt: "@C look",
        authorName: "A",
        authorId: A.id,
        href: `/workspaces/${ID.workspace}`,
        userIds: [C.id],
      });
    }
    const received = await db.notification.findMany({ where: { userId: C.id, type: "MENTIONED" } });
    expect(received).toHaveLength(10);
    // The author's id isn't copied into what the recipient's notification stores.
    expect(JSON.stringify(received[0]?.payload)).not.toContain("authorId");
  });
});
