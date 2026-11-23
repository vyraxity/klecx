/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { strFromU8, unzipSync } from "fflate";
import { db } from "@/server/db/client";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { setStorageProvider } from "@/server/storage";
import { MockStorageProvider } from "@/server/storage/mock";
import { setBillingProviderForTests } from "@/server/billing/get-provider";
import type { BillingProvider } from "@/server/billing/provider";
import {
  buildDataExport,
  getDataExportDownloadUrl,
  getDataExports,
  requestDataExport,
} from "@/server/services/data-export";
import {
  deletedUserEmail,
  getDeletionOverview,
  purgeDeletedAccount,
  purgeDueAccounts,
  requestAccountDeletion,
  restoreAccount,
} from "@/server/services/account-deletion";
import { getSignInBlock } from "@/server/services/account-moderation";
import { resolvePublicShareByToken, hashShareToken } from "@/server/services/share";
import { GET as exportsGet, POST as exportsPost } from "@/app/api/v1/me/exports/route";
import { GET as downloadGet } from "@/app/api/v1/me/exports/[id]/download/route";
import { GET as deletionGet, POST as deletionPost } from "@/app/api/v1/me/account/deletion/route";
import { POST as restorePost } from "@/app/api/v1/account/restore/route";
import { POST as adminPurgePost } from "@/app/api/v1/admin/users/[id]/purge-deleted/route";
import { resetInMemoryRateLimits } from "@/server/http/rate-limit";
import type { Actor } from "@/server/auth/session";

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => {
  const actual = jest.requireActual("../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});

const sentEmails: { template: string; to: string; data: Record<string, unknown> }[] = [];
jest.mock("../server/email/send", () => {
  const actual = jest.requireActual("../server/email/send");
  return {
    ...actual,
    sendEmail: jest.fn(async (template: string, to: string, data: Record<string, unknown>) => {
      sentEmails.push({ template, to, data });
      return { id: "mock" };
    }),
  };
});

const sfx = `${Date.now()}`.slice(-7);
const A = { id: `u95_a_${sfx}`, email: `u95_a_${sfx}@example.com` }; // deletes their account
const B = { id: `u95_b_${sfx}`, email: `u95_b_${sfx}@example.com` }; // owns a shared workspace A is in
const C = { id: `u95_c_${sfx}`, email: `u95_c_${sfx}@example.com` }; // outsider; member of A's shared workspace
const ids = [A.id, B.id, C.id];
const WA = `w95_a_${sfx}`; // A's own workspace (no other members)
const WS = `w95_s_${sfx}`; // A's workspace shared with C (a blocker)
const WB = `w95_b_${sfx}`; // B's workspace, A is a member
const SHARE_TOKEN = `share95_${sfx}_token`;

const actor = (u: { id: string; email: string }) => ({ userId: u.id, email: u.email, role: "USER", sessionId: `s95_${u.id}` }) as Actor;
const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const cancelCalls: { id: string; atPeriodEnd: boolean }[] = [];
const fakeBilling = {
  name: "fake",
  cancelSubscription: jest.fn(async (id: string, o: { atPeriodEnd: boolean }) => {
    cancelCalls.push({ id, atPeriodEnd: o.atPeriodEnd });
  }),
} as unknown as BillingProvider;

let storage: MockStorageProvider;
let fileProviderId = "";
let bigFileProviderId = "";
let commentInBId = "";
let privateAskInBId = "";

async function cleanup() {
  await db.accountDeletion.deleteMany({ where: { userId: { in: ids } } });
  await db.dataExport.deleteMany({ where: { userId: { in: ids } } });
  await db.workspace.deleteMany({ where: { id: { in: [WA, WS, WB] } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.subscription.deleteMany({ where: { userId: { in: ids } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function freshSession(u: { id: string }) {
  await db.session.upsert({
    where: { id: `s95_${u.id}` },
    create: { id: `s95_${u.id}`, userId: u.id, token: `tok95_${u.id}`, expiresAt: new Date(Date.now() + 86_400_000) },
    update: { createdAt: new Date() },
  });
}

beforeAll(async () => {
  await cleanup();
  storage = new MockStorageProvider();
  setStorageProvider(storage);
  setBillingProviderForTests(fakeBilling);
  for (const u of [A, B, C]) {
    await db.user.create({ data: { id: u.id, email: u.email, name: `Name ${u.id}`, emailVerified: true, username: `user95${u.id.slice(-9)}` } });
    await createAccountWithFreeGrant(u.id);
  }
  await db.userPreference.create({ data: { userId: A.id, theme: "DARK" } });
  await db.account.create({ data: { id: `acc95_${sfx}`, userId: A.id, accountId: A.id, providerId: "credential", password: "x" } });

  // A's own workspace: a conversation with an edit, a document, a file, a share link.
  await db.workspace.create({ data: { id: WA, ownerId: A.id, title: "My research" } });
  const r = await db.response.create({ data: { workspaceId: WA, createdById: A.id, prompt: "Explain Raft" } });
  const v = await db.responseVersion.create({
    data: { responseId: r.id, number: 1, modelKey: "text-economy", providerModelId: "x", promptVersion: "1", createdById: A.id, content: "Raft is a consensus algorithm.", status: "COMPLETE" },
  });
  await db.responseEdit.create({ data: { versionId: v.id, revision: 1, content: "Raft is an easy consensus algorithm.", editorId: A.id } });
  const doc = await db.document.create({ data: { workspaceId: WA, versionId: v.id, title: "Summary", format: "md", createdById: A.id } });
  await db.documentRevision.create({ data: { documentId: doc.id, revision: 1, content: "# Summary\n\nFirst." } });
  await db.annotation.create({
    data: { workspaceId: WA, createdById: A.id, kind: "COMMENT", versionId: v.id, responseId: r.id, anchorExact: "Raft", anchorPrefix: "", anchorSuffix: "", visibility: "WORKSPACE", messages: { create: { role: "USER", content: "Check this", authorId: A.id } } },
  });
  const up = await storage.uploadBuffer(Buffer.from("hello file"), { publicId: `klecx/dev/${WA}/f1`, resourceType: "raw", format: "txt" });
  fileProviderId = up.publicId;
  await db.attachment.create({ data: { ownerId: A.id, workspaceId: WA, kind: "DOCUMENT", status: "READY", providerId: fileProviderId, resourceType: "raw", mime: "text/plain", bytes: 10, originalName: "notes.txt" } });
  const big = await storage.uploadBuffer(Buffer.from("pretend this is huge"), { publicId: `klecx/dev/${WA}/f2`, resourceType: "raw", format: "bin" });
  bigFileProviderId = big.publicId;
  await db.attachment.create({ data: { ownerId: A.id, workspaceId: WA, kind: "DOCUMENT", status: "READY", providerId: bigFileProviderId, resourceType: "raw", mime: "application/octet-stream", bytes: 200 * 1024 * 1024, originalName: "huge.bin" } });
  await db.shareLink.create({ data: { workspaceId: WA, scope: "WORKSPACE", tokenHash: hashShareToken(SHARE_TOKEN), tokenPrefix: "share95", createdById: A.id } });

  // A's workspace shared with C.
  await db.workspace.create({ data: { id: WS, ownerId: A.id, title: "Shared plan" } });
  await db.workspaceMember.create({ data: { workspaceId: WS, userId: C.id, role: "VIEWER", invitedById: A.id } });

  // B's workspace with A as a member: a comment (stays) and a private Ask (erased).
  await db.workspace.create({ data: { id: WB, ownerId: B.id, title: "B's space" } });
  await db.workspaceMember.create({ data: { workspaceId: WB, userId: A.id, role: "EDITOR", invitedById: B.id } });
  const rb = await db.response.create({ data: { workspaceId: WB, createdById: B.id, prompt: "B's question" } });
  const vb = await db.responseVersion.create({ data: { responseId: rb.id, number: 1, modelKey: "text-economy", providerModelId: "x", promptVersion: "1", createdById: B.id, content: "B's answer", status: "COMPLETE" } });
  commentInBId = (
    await db.annotation.create({
      data: { workspaceId: WB, createdById: A.id, kind: "COMMENT", versionId: vb.id, responseId: rb.id, anchorExact: "answer", anchorPrefix: "", anchorSuffix: "", visibility: "WORKSPACE", messages: { create: { role: "USER", content: "A's public comment", authorId: A.id } } },
    })
  ).id;
  privateAskInBId = (
    await db.annotation.create({
      data: { workspaceId: WB, createdById: A.id, kind: "ASK", versionId: vb.id, responseId: rb.id, anchorExact: "B's", anchorPrefix: "", anchorSuffix: "", visibility: "PRIVATE", messages: { create: [{ role: "USER", content: "A's private question", authorId: A.id }, { role: "ASSISTANT", content: "Private answer" }] } },
    })
  ).id;

  await db.subscription.create({
    data: { userId: A.id, plan: "LITE", interval: "MONTH", status: "ACTIVE", providerCustomerId: `c95_${sfx}`, providerSubscriptionId: `sub95_${sfx}`, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) },
  });
});

afterAll(async () => {
  setStorageProvider(null);
  setBillingProviderForTests(undefined);
  await cleanup();
});

beforeEach(() => {
  mockActor = null;
  sentEmails.length = 0;
  resetInMemoryRateLimits();
});

describe("Step 9.5 — data export", () => {
  let exportId = "";

  it("builds a ZIP of the person's data, with files up to the budget, and emails them", async () => {
    const created = await requestDataExport(actor(A));
    exportId = created.id;
    expect(created.status).toBe("PENDING");
    await buildDataExport(created.id, { locale: "en" });

    const row = await db.dataExport.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe("READY");
    expect(row.storageId).toBe(`klecx/dev/exports/${A.id}/${created.id}`);
    expect(row.filesIncluded).toBe(1);
    expect(row.filesSkipped).toBe(1); // the 200 MB file is over the 100 MB budget
    expect(row.expiresAt!.getTime() - row.finishedAt!.getTime()).toBe(24 * 3600 * 1000);
    expect(sentEmails).toEqual([expect.objectContaining({ template: "data-export-ready", to: A.email })]);

    const zip = unzipSync(new Uint8Array(await storage.downloadBuffer(row.storageId!)));
    const names = Object.keys(zip);
    expect(names).toEqual(expect.arrayContaining(["README.txt", "account.json", "credits.csv", "projects.json", "contributions.json", "files-not-included.txt"]));
    const account = JSON.parse(strFromU8(zip["account.json"]!));
    expect(account.profile.email).toBe(A.email);
    expect(account.preferences.theme).toBe("DARK");
    expect(JSON.stringify(account)).not.toContain('"password"');

    const folder = names.find((n) => n.endsWith("My-research/conversation.md"))!.replace("/conversation.md", "");
    const md = strFromU8(zip[`${folder}/conversation.md`]!);
    expect(md).toContain("Explain Raft");
    expect(md).toContain("Raft is a consensus algorithm.");
    expect(md).toContain("Raft is an easy consensus algorithm."); // the saved edit
    expect(strFromU8(zip[`${folder}/files/notes.txt`]!)).toBe("hello file");
    expect(strFromU8(zip[`${folder}/documents/Summary-r1.md`]!)).toContain("First.");
    const ws = JSON.parse(strFromU8(zip[`${folder}/workspace.json`]!));
    expect(JSON.stringify(ws.shareLinks)).not.toContain("tokenHash");
    expect(strFromU8(zip["files-not-included.txt"]!)).toContain("huge.bin");

    // Their comment and private Ask in B's workspace are theirs; B's own content isn't exported.
    const contributions = JSON.parse(strFromU8(zip["contributions.json"]!));
    expect(contributions.threads.map((t: { id: string }) => t.id).sort()).toEqual([commentInBId, privateAskInBId].sort());
    expect(names.some((n) => n.includes("B-s-space"))).toBe(false);
  });

  it("one export per day; only its owner can download it, while it's valid", async () => {
    await expect(requestDataExport(actor(A))).rejects.toMatchObject({ status: 429, code: "export_limit" });
    const url = await getDataExportDownloadUrl(actor(A), exportId);
    expect(url).toContain(`exports/${A.id}/${exportId}`);
    await expect(getDataExportDownloadUrl(actor(B), exportId)).rejects.toMatchObject({ status: 404 });
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    await expect(getDataExportDownloadUrl(actor(A), exportId, later)).rejects.toMatchObject({ status: 410 });
    // Once expired, the file is deleted when the page is opened.
    const overview = await getDataExports(A.id, later);
    expect(overview.exports[0]).toMatchObject({ id: exportId, status: "EXPIRED" });
    expect(overview.nextAllowedAt).toBeNull();
    expect((await db.dataExport.findUniqueOrThrow({ where: { id: exportId } })).storageId).toBeNull();
  });

  it("routes: 401 signed out, 404 for another person's export", async () => {
    expect((await exportsGet(req("/api/v1/me/exports"))).status).toBe(401);
    expect((await exportsPost(req("/api/v1/me/exports", "POST"))).status).toBe(401);
    mockActor = actor(B);
    const res = await downloadGet(req(`/api/v1/me/exports/${exportId}/download`), { params: Promise.resolve({ id: exportId }) });
    expect(res.status).toBe(404);
    const list = await (await exportsGet(req("/api/v1/me/exports"))).json();
    expect(list.data.exports).toEqual([]);
  });
});

describe("Step 9.5 — account deletion", () => {
  let restoreToken = "";

  it("is blocked while a workspace the person owns has other members", async () => {
    await freshSession(A);
    const overview = await getDeletionOverview(A.id);
    expect(overview.blockers).toEqual([expect.objectContaining({ type: "workspace", id: WS, memberCount: 1 })]);
    expect(overview.subscription).toMatchObject({ plan: "LITE" });
    await expect(requestAccountDeletion(actor(A), { confirmEmail: A.email }, "r1")).rejects.toMatchObject({ status: 409, code: "deletion_blocked" });
    expect(cancelCalls).toEqual([]);
  });

  it("needs the email typed exactly, and a fresh sign-in or the password", async () => {
    await db.workspace.update({ where: { id: WS }, data: { deletedAt: new Date() } }); // "delete instead"
    await expect(requestAccountDeletion(actor(A), { confirmEmail: "someone@else.com" }, "r1")).rejects.toMatchObject({ status: 422, code: "confirmation_mismatch" });
    await db.session.update({ where: { id: `s95_${A.id}` }, data: { createdAt: new Date(Date.now() - 3600_000) } });
    await expect(requestAccountDeletion(actor(A), { confirmEmail: A.email }, "r1")).rejects.toMatchObject({ code: "FRESH_LOGIN_REQUIRED" });
  });

  it("deletes: plan cancelled at period end, signed out, sign-in blocked, links dead, access paused", async () => {
    await freshSession(A);
    expect(await resolvePublicShareByToken(SHARE_TOKEN)).toBeTruthy();
    const res = await requestAccountDeletion(actor(A), { confirmEmail: ` ${A.email.toUpperCase()} ` }, "r1");
    const purgeAfter = new Date(res.purgeAfter).getTime();
    expect(purgeAfter - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    expect(cancelCalls).toEqual([{ id: `sub95_${sfx}`, atPeriodEnd: true }]);
    expect((await db.subscription.findUniqueOrThrow({ where: { userId: A.id } })).cancelAtPeriodEnd).toBe(true);
    expect(await db.session.count({ where: { userId: A.id } })).toBe(0);
    expect(await getSignInBlock(A.id)).toBe("deleted");
    await expect(resolvePublicShareByToken(SHARE_TOKEN)).rejects.toMatchObject({ status: 404 });
    const membership = await db.workspaceMember.findFirstOrThrow({ where: { workspaceId: WB, userId: A.id } });
    expect(membership.suspendedReason).toBe("account_deleted");
    const email = sentEmails.find((e) => e.template === "account-deletion-scheduled")!;
    expect(email.to).toBe(A.email);
    restoreToken = new URL(String(email.data.restoreUrl)).searchParams.get("token")!;
    expect(restoreToken.length).toBeGreaterThan(20);
  });

  it("the emailed link restores the account", async () => {
    await expect(restoreAccount("not-a-real-token-value")).rejects.toMatchObject({ status: 410 });
    const res = await restorePost(req("/api/v1/account/restore", "POST", { token: restoreToken }));
    expect(res.status).toBe(200);
    expect(await getSignInBlock(A.id)).toBeNull();
    expect((await db.workspaceMember.findFirstOrThrow({ where: { workspaceId: WB, userId: A.id } })).suspendedAt).toBeNull();
    expect(await resolvePublicShareByToken(SHARE_TOKEN)).toBeTruthy();
    await expect(restoreAccount(restoreToken)).rejects.toMatchObject({ status: 410 }); // used once
  });

  it("after the grace period the account is erased; billing records and shared comments stay", async () => {
    await freshSession(A);
    await requestAccountDeletion(actor(A), { confirmEmail: A.email }, "r2");
    await expect(purgeDeletedAccount(A.id)).rejects.toMatchObject({ code: "purge_not_due" });

    const ledgerBefore = await db.creditLedger.count({ where: { account: { userId: A.id } } });
    const result = await purgeDueAccounts(new Date(Date.now() + 31 * 86_400_000));
    expect(result).toEqual({ purged: 1, failed: 0 });

    const user = await db.user.findUniqueOrThrow({ where: { id: A.id } });
    expect(user).toMatchObject({ name: "Deleted user", email: deletedUserEmail(A.id), username: null, image: null });
    expect(await db.workspace.count({ where: { ownerId: A.id } })).toBe(0);
    expect(await storage.head(fileProviderId)).toBeNull();
    expect(await storage.head(bigFileProviderId)).toBeNull();
    expect(await db.dataExport.count({ where: { userId: A.id } })).toBe(0);
    expect(await db.userPreference.count({ where: { userId: A.id } })).toBe(0);
    expect(await db.account.count({ where: { userId: A.id } })).toBe(0);
    expect(await db.workspaceMember.count({ where: { userId: A.id } })).toBe(0);
    // Kept: credit and billing records, and what they said in other people's workspaces.
    expect(await db.creditLedger.count({ where: { account: { userId: A.id } } })).toBe(ledgerBefore);
    expect(await db.subscription.count({ where: { userId: A.id } })).toBe(1);
    expect(await db.annotation.findUnique({ where: { id: commentInBId } })).not.toBeNull();
    expect(await db.annotation.findUnique({ where: { id: privateAskInBId } })).toBeNull();
    // The link can't bring it back, and a second run does nothing.
    await expect(restoreAccount(restoreToken)).rejects.toMatchObject({ status: 410 });
    expect(await purgeDeletedAccount(A.id, { force: true })).toEqual({ purged: false });
  });

  it("routes: 401 signed out; only admins can purge, and only deleted accounts", async () => {
    expect((await deletionGet(req("/api/v1/me/account/deletion"))).status).toBe(401);
    expect((await deletionPost(req("/api/v1/me/account/deletion", "POST", { confirmEmail: "x@y.z" }))).status).toBe(401);
    mockActor = actor(B);
    const forbidden = await adminPurgePost(req(`/api/v1/admin/users/${C.id}/purge-deleted`, "POST", {}), { params: Promise.resolve({ id: C.id }) });
    expect(forbidden.status).toBe(403);
    mockActor = { ...actor(B), role: "ADMIN" };
    const notDeleted = await adminPurgePost(req(`/api/v1/admin/users/${C.id}/purge-deleted`, "POST", { force: true }), { params: Promise.resolve({ id: C.id }) });
    expect(notDeleted.status).toBe(404);
  });
});
