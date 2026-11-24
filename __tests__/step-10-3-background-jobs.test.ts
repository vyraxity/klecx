/**
 * @jest-environment node
 *
 * Step 10.3 — background jobs: the cron route (bearer secret, unknown job),
 * the lease lock and run history, and every job: a unit test and a "run twice
 * → same result" test. Jobs act on the whole database, so most tests call
 * them with a `now` in March 2001 and seed rows dated in 2000: rows of other
 * test files (dated today) are never old enough to be touched.
 */
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { setStorageProvider } from "@/server/storage/provider";
import { MockStorageProvider } from "@/server/storage/mock";
import { setBillingProviderForTests } from "@/server/billing/get-provider";
import type { BillingProvider } from "@/server/billing/provider";
import { acquireJobLock, releaseJobLock, runWithLock } from "@/server/jobs/runner";
import { authorizeCron } from "@/server/jobs/auth";
import { reapStuckAskMessages, reapStuckGenerations } from "@/server/jobs/reap";
import { sendPendingEmails } from "@/server/jobs/emails";
import { expireInvitesAndShares, expireOwnershipTransfers } from "@/server/jobs/expiry";
import {
  cleanOrphanAttachments,
  purgeDeletedContent,
  purgeSpeechCache,
  purgeSupportScreenshots,
  pruneJobRuns,
} from "@/server/jobs/cleanup";
import { enforceMemberLimits, reconcileBilling, refreshCreditPeriods } from "@/server/jobs/billing";
import { MAX_EMAIL_ATTEMPTS, nextEmailAttemptAt, notify } from "@/server/services/notify";
import { evaluateAlerts } from "@/server/monitoring/alerts";
import { JOB_GROUPS, JOB_NAMES, JOB_SCHEDULES } from "@/lib/jobs/schedules";
import { GET as cronGET, POST as cronPOST } from "@/app/api/cron/[job]/route";

jest.mock("../server/auth/session", () => ({ getActor: jest.fn(async () => null) }));
jest.mock("../server/monitoring/sentry", () => ({ captureServerError: jest.fn() }));

const mockSend = jest.fn<Promise<{ success: boolean }>, unknown[]>(async () => ({ success: true }));
jest.mock("../server/email/send", () => {
  const actual = jest.requireActual("../server/email/send");
  return { ...actual, sendEmail: (...a: unknown[]) => mockSend(...a) };
});

const sfx = `${Date.now()}`.slice(-7);
const SECRET = `cron-test-secret-${sfx}-0123456789abcdef`;
const NOW = new Date("2001-03-15T12:00:00Z");
const OLD = new Date("2000-06-01T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const OWNER = `job_owner_${sfx}`;
const OTHER = `job_other_${sfx}`;
const users = [OWNER, OTHER];
let accountId = "";
let workspaceId = "";
const storage = new MockStorageProvider();

beforeAll(async () => {
  setStorageProvider(storage);
  (env as { CRON_SECRET?: string }).CRON_SECRET = SECRET;
  for (const id of users) {
    await db.user.create({ data: { id, name: id, email: `${id}@example.com`, emailVerified: true } });
  }
  accountId = (await db.creditAccount.create({ data: { userId: OWNER, planBalance: 95 } })).id;
  workspaceId = (await db.workspace.create({ data: { ownerId: OWNER, title: "Jobs" } })).id;
});

beforeEach(() => mockSend.mockClear());

afterAll(async () => {
  setStorageProvider(null);
  setBillingProviderForTests(undefined);
  await db.jobRun.deleteMany({ where: { job: { contains: sfx } } });
  await db.jobLock.deleteMany({ where: { job: { contains: sfx } } });
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.subscription.deleteMany({ where: { userId: { in: users } } });
  await db.memberLimitGrace.deleteMany({ where: { ownerId: { in: users } } });
  await db.ownershipTransfer.deleteMany({ where: { fromUserId: { in: users } } });
  await db.invitation.deleteMany({ where: { invitedById: { in: users } } });
  await db.dataExport.deleteMany({ where: { userId: { in: users } } });
  await db.supportTicket.deleteMany({ where: { email: { contains: sfx } } });
  await db.speechCache.deleteMany({ where: { key: { contains: sfx } } });
  await db.attachment.deleteMany({ where: { ownerId: { in: users } } });
  await db.workspace.deleteMany({ where: { ownerId: { in: users } } });
  await db.project.deleteMany({ where: { ownerId: { in: users } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

function cronReq(job: string, auth?: string, method = "POST") {
  return new NextRequest(`http://localhost:3000/api/cron/${job}`, {
    method,
    headers: auth ? { authorization: auth } : {},
  });
}

describe("cron route", () => {
  test("refuses a missing or wrong secret (401) and an unknown job (404)", async () => {
    const params = { params: Promise.resolve({ job: "prune-job-runs" }) };
    expect((await cronPOST(cronReq("prune-job-runs"), params)).status).toBe(401);
    expect((await cronPOST(cronReq("prune-job-runs", "Bearer wrong"), params)).status).toBe(401);
    expect((await cronPOST(cronReq("prune-job-runs", SECRET), params)).status).toBe(401); // no "Bearer"
    const unknown = await cronPOST(cronReq("drop-tables", `Bearer ${SECRET}`), {
      params: Promise.resolve({ job: "drop-tables" }),
    });
    expect(unknown.status).toBe(404);
  });

  test("runs a job with the secret (POST, and GET as Vercel Cron sends) and records the run", async () => {
    const params = { params: Promise.resolve({ job: "prune-job-runs" }) };
    const res = await cronPOST(cronReq("prune-job-runs", `Bearer ${SECRET}`), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ job: "prune-job-runs", status: "SUCCEEDED" });
    const viaGet = await cronGET(cronReq("prune-job-runs", `Bearer ${SECRET}`, "GET"), {
      params: Promise.resolve({ job: "prune-job-runs" }),
    });
    expect(viaGet.status).toBe(200);
    const runs = await db.jobRun.findMany({ where: { job: "prune-job-runs" }, orderBy: { startedAt: "desc" }, take: 2 });
    expect(runs.every((r) => r.status === "SUCCEEDED" && r.finishedAt)).toBe(true);
  });

  test("no CRON_SECRET configured → every call refused", () => {
    expect(() => authorizeCron(`Bearer ${SECRET}`, null)).toThrow();
    expect(() => authorizeCron(`Bearer ${SECRET}`, SECRET)).not.toThrow();
  });
});

describe("runner", () => {
  test("an overlapping run is skipped; the lease frees on finish", async () => {
    const job = `test-lock-${sfx}`;
    expect(await acquireJobLock(job, "holder-a")).toBe(true);
    expect(await acquireJobLock(job, "holder-b")).toBe(false);
    const skipped = await runWithLock(job, async () => ({ n: 1 }));
    expect(skipped.status).toBe("SKIPPED");
    await releaseJobLock(job, "holder-a");
    const ran = await runWithLock(job, async () => ({ n: 1 }));
    expect(ran).toMatchObject({ status: "SUCCEEDED", result: { n: 1 } });
    // Released after the run: the next one runs too.
    expect((await runWithLock(job, async () => ({ n: 2 }))).status).toBe("SUCCEEDED");
  });

  test("an expired lease (a killed run) can be taken over", async () => {
    const job = `test-lease-${sfx}`;
    expect(await acquireJobLock(job, "dead", -1000)).toBe(true);
    expect(await acquireJobLock(job, "alive")).toBe(true);
    await releaseJobLock(job, "alive");
  });

  test("a throwing job and a job with failed items are recorded as FAILED, with a code only", async () => {
    const job = `test-fail-${sfx}`;
    const thrown = await runWithLock(job, async () => {
      throw Object.assign(new Error("secret detail user@example.com"), { code: "boom" });
    });
    expect(thrown).toMatchObject({ status: "FAILED", errorCode: "boom" });
    const partial = await runWithLock(job, async () => ({ done: 3, failed: 1 }));
    expect(partial).toMatchObject({ status: "FAILED", errorCode: "partial_failure" });
    const rows = await db.jobRun.findMany({ where: { job } });
    expect(rows.map((r) => r.status).sort()).toEqual(["FAILED", "FAILED"]);
    expect(JSON.stringify(rows)).not.toContain("user@example.com");
  });
});

describe("reap-generations / reap-ask-messages", () => {
  async function stuckGeneration(startedAt: Date) {
    const id = crypto.randomUUID();
    const response = await db.response.create({ data: { workspaceId, createdById: OWNER, prompt: "q" } });
    const version = await db.responseVersion.create({
      data: { responseId: response.id, number: 1, modelKey: "text-economy", providerModelId: "x", promptVersion: "1", createdById: OWNER, generationId: id },
    });
    await db.creditLedger.create({
      data: { accountId, type: "RESERVE", planDelta: -5, topupDelta: 0, planAfter: 90, topupAfter: 0, generationId: id, idempotencyKey: `reserve:${id}` },
    });
    await db.creditAccount.update({ where: { id: accountId }, data: { planBalance: { decrement: 5 } } });
    await db.generation.create({
      data: {
        id, workspaceId, versionId: version.id, actorId: OWNER, billedAccountId: accountId, kind: "TEXT", status: "RUNNING",
        modelKey: "text-economy", providerModelId: "x", promptVersion: "1", idempotencyKey: `reap_${id}`, reservedCredits: 5, startedAt, createdAt: startedAt,
      },
    });
    return { id, versionId: version.id };
  }

  test("a RUNNING call older than 10 min → FAILED, credits released once; a recent one is left alone", async () => {
    const before = (await db.creditAccount.findUniqueOrThrow({ where: { id: accountId } })).planBalance;
    const old = await stuckGeneration(ago(11 * MIN));
    const recent = await stuckGeneration(ago(2 * MIN));

    const first = await reapStuckGenerations(NOW);
    expect(first).toMatchObject({ reaped: 1, released: 1, failed: 0 });
    expect((await db.generation.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("FAILED");
    expect((await db.responseVersion.findUniqueOrThrow({ where: { id: old.versionId } })).status).toBe("FAILED");
    expect((await db.generation.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe("RUNNING");
    const afterFirst = (await db.creditAccount.findUniqueOrThrow({ where: { id: accountId } })).planBalance;
    expect(afterFirst).toBe(before - 10 + 5);

    // Run twice → same result.
    expect(await reapStuckGenerations(NOW)).toMatchObject({ reaped: 0, released: 0 });
    expect((await db.creditAccount.findUniqueOrThrow({ where: { id: accountId } })).planBalance).toBe(afterFirst);
    expect(await db.creditLedger.count({ where: { generationId: old.id, type: "RELEASE" } })).toBe(1);
  });

  test("Ask answers still STREAMING and questions still ANSWERING → FAILED", async () => {
    const response = await db.response.create({ data: { workspaceId, createdById: OWNER, prompt: "q" } });
    const version = await db.responseVersion.create({
      data: { responseId: response.id, number: 1, status: "COMPLETE", modelKey: "text-economy", providerModelId: "x", promptVersion: "1", createdById: OWNER },
    });
    const annotation = await db.annotation.create({
      data: {
        workspaceId, responseId: response.id, versionId: version.id, createdById: OWNER, kind: "ASK", anchorExact: "x", anchorPrefix: "", anchorSuffix: "",
        questionState: "ANSWERING",
      },
    });
    await db.$executeRaw`UPDATE annotations SET updated_at = ${OLD} WHERE id = ${annotation.id}`;
    const msg = await db.annotationMessage.create({
      data: { annotationId: annotation.id, role: "ASSISTANT", content: "", status: "STREAMING", createdAt: OLD },
    });
    const first = await reapStuckAskMessages(NOW);
    expect(first.messages).toBeGreaterThanOrEqual(1);
    expect(first.questions).toBeGreaterThanOrEqual(1);
    expect((await db.annotationMessage.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("FAILED");
    expect((await db.annotation.findUniqueOrThrow({ where: { id: annotation.id } })).questionState).toBe("FAILED");
    expect(await reapStuckAskMessages(NOW)).toEqual({ messages: 0, questions: 0 });
  });
});

describe("send-emails", () => {
  test("a failed email is retried with backoff, sent once, then left alone", async () => {
    const n = await db.notification.create({
      data: {
        userId: OWNER, type: "MEMBER_SUSPENDED", payload: { resourceName: "WS", href: "/workspaces/x" },
        emailStatus: "FAILED", emailAttempts: 1, emailNextAttemptAt: ago(MIN), createdAt: OLD,
      },
    });
    const first = await sendPendingEmails(NOW);
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(mockSend).toHaveBeenCalledWith("member-suspended", `${OWNER}@example.com`, expect.anything(), expect.anything());
    const row = await db.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({ emailStatus: "SENT", emailAttempts: 2, emailNextAttemptAt: null });

    mockSend.mockClear();
    await sendPendingEmails(NOW);
    expect(mockSend).not.toHaveBeenCalledWith("member-suspended", `${OWNER}@example.com`, expect.anything(), expect.anything());
  });

  test("gives up after the last attempt; the share-created email (live link never stored) isn't retried", async () => {
    mockSend.mockResolvedValue({ success: false });
    const last = await db.notification.create({
      data: {
        userId: OWNER, type: "MEMBER_RESTORED", payload: { resourceName: "WS" },
        emailStatus: "FAILED", emailAttempts: MAX_EMAIL_ATTEMPTS - 1, emailNextAttemptAt: ago(MIN), createdAt: OLD,
      },
    });
    const share = await db.notification.create({
      data: {
        userId: OWNER, type: "SHARE_CREATED", payload: { title: "T" },
        emailStatus: "FAILED", emailAttempts: 1, emailNextAttemptAt: ago(MIN), createdAt: OLD,
      },
    });
    await sendPendingEmails(NOW);
    expect(await db.notification.findUniqueOrThrow({ where: { id: last.id } })).toMatchObject({
      emailStatus: "FAILED", emailAttempts: MAX_EMAIL_ATTEMPTS, emailNextAttemptAt: null,
    });
    expect(await db.notification.findUniqueOrThrow({ where: { id: share.id } })).toMatchObject({
      emailStatus: "FAILED", emailNextAttemptAt: null,
    });
    mockSend.mockResolvedValue({ success: true });
  });

  test("notify() schedules a retry when the inline send fails", async () => {
    mockSend.mockResolvedValue({ success: false });
    const out = await notify(OTHER, "MEMBER_SUSPENDED", { resourceName: "WS", href: "/workspaces/y" });
    mockSend.mockResolvedValue({ success: true });
    const row = await db.notification.findUniqueOrThrow({ where: { id: out.notification!.id } });
    expect(row.emailStatus).toBe("FAILED");
    expect(row.emailAttempts).toBe(1);
    expect(row.emailNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(nextEmailAttemptAt(MAX_EMAIL_ATTEMPTS, NOW)).toBeNull();
  });
});

describe("expiry jobs", () => {
  test("expire-invites-shares: pending invitations past their date → EXPIRED", async () => {
    const inv = await db.invitation.create({
      data: { workspaceId, email: `inv_${sfx}@example.com`, role: "EDITOR", tokenHash: `th_${sfx}`, invitedById: OWNER, expiresAt: OLD },
    });
    const live = await db.invitation.create({
      data: { workspaceId, email: `inv2_${sfx}@example.com`, role: "EDITOR", tokenHash: `th2_${sfx}`, invitedById: OWNER, expiresAt: new Date(NOW.getTime() + DAY) },
    });
    expect((await expireInvitesAndShares(NOW)).invitations).toBeGreaterThanOrEqual(1);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("EXPIRED");
    expect((await db.invitation.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("PENDING");
    expect((await expireInvitesAndShares(NOW)).invitations).toBe(0);
  });

  test("expire-ownership-transfers: EXPIRED and the sender told once", async () => {
    const t = await db.ownershipTransfer.create({
      data: { workspaceId, fromUserId: OWNER, toUserId: OTHER, expiresAt: OLD },
    });
    expect((await expireOwnershipTransfers(NOW)).expired).toBeGreaterThanOrEqual(1);
    expect((await db.ownershipTransfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("EXPIRED");
    expect(await expireOwnershipTransfers(NOW)).toMatchObject({ expired: 0 });
    const notes = await db.notification.findMany({ where: { userId: OWNER, type: "OWNERSHIP_TRANSFER_EXPIRED" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload).toMatchObject({ toUserName: OTHER, resourceName: "Jobs" });
  });
});

describe("storage clean-up", () => {
  test("orphan-attachments: old unfinished and never-sent uploads and expired exports go; used ones stay", async () => {
    const mk = async (over: Record<string, unknown>) => {
      const providerId = `klecx/test/${crypto.randomUUID()}`;
      storage.seedFile(providerId, Buffer.from("x"));
      const a = await db.attachment.create({
        data: { ownerId: OWNER, workspaceId, kind: "IMAGE", providerId, resourceType: "image", mime: "image/png", bytes: 1, originalName: "a.png", createdAt: OLD, ...over } as never,
      });
      return { id: a.id, providerId };
    };
    const pending = await mk({ status: "PENDING" });
    const unlinked = await mk({ status: "READY" });
    const response = await db.response.create({ data: { workspaceId, createdById: OWNER, prompt: "p" } });
    const linked = await mk({ status: "READY", responseId: response.id });
    const fresh = await mk({ status: "READY", createdAt: ago(2 * 60 * MIN) });
    const exportFile = `klecx/test/exports/${sfx}`;
    storage.seedFile(exportFile, Buffer.from("zip"));
    const exp = await db.dataExport.create({ data: { userId: OWNER, status: "READY", storageId: exportFile, expiresAt: OLD } });

    const first = await cleanOrphanAttachments(NOW);
    expect(first.attachments).toBeGreaterThanOrEqual(2);
    expect(first.exports).toBeGreaterThanOrEqual(1);
    for (const gone of [pending, unlinked]) {
      expect(storage.hasFile(gone.providerId)).toBe(false);
      expect((await db.attachment.findUniqueOrThrow({ where: { id: gone.id } })).status).toBe("DELETED");
    }
    for (const kept of [linked, fresh]) {
      expect(storage.hasFile(kept.providerId)).toBe(true);
      expect((await db.attachment.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("READY");
    }
    expect(storage.hasFile(exportFile)).toBe(false);
    expect((await db.dataExport.findUniqueOrThrow({ where: { id: exp.id } })).storageId).toBeNull();

    expect(await cleanOrphanAttachments(NOW)).toMatchObject({ attachments: 0, exports: 0, failed: 0 });
  });

  test("purge-deleted: a workspace deleted > 30 days ago is erased with its files; a recent one stays", async () => {
    const oldWs = await db.workspace.create({ data: { ownerId: OWNER, title: "Old", deletedAt: ago(31 * DAY) } });
    const newWs = await db.workspace.create({ data: { ownerId: OWNER, title: "New", deletedAt: ago(5 * DAY) } });
    const oldProject = await db.project.create({ data: { ownerId: OWNER, name: "P", deletedAt: ago(40 * DAY) } });
    const kept = await db.workspace.create({ data: { ownerId: OWNER, title: "In project", projectId: oldProject.id } });
    const providerId = `klecx/test/${crypto.randomUUID()}`;
    storage.seedFile(providerId, Buffer.from("x"));
    await db.attachment.create({
      data: { ownerId: OWNER, workspaceId: oldWs.id, kind: "DOCUMENT", status: "READY", providerId, resourceType: "raw", mime: "text/plain", bytes: 1, originalName: "a.txt" },
    });

    const first = await purgeDeletedContent(NOW);
    expect(first).toMatchObject({ failed: 0 });
    expect(first.workspaces).toBeGreaterThanOrEqual(1);
    expect(await db.workspace.findUnique({ where: { id: oldWs.id } })).toBeNull();
    expect(storage.hasFile(providerId)).toBe(false);
    expect(await db.workspace.findUnique({ where: { id: newWs.id } })).not.toBeNull();
    expect(await db.project.findUnique({ where: { id: oldProject.id } })).toBeNull();
    // The project's workspace wasn't deleted with it: it only loses the link.
    expect((await db.workspace.findUniqueOrThrow({ where: { id: kept.id } })).projectId).toBeNull();

    expect(await purgeDeletedContent(NOW)).toMatchObject({ workspaces: 0, projects: 0, responses: 0, failed: 0 });
  });

  test("purge-support-screenshots: older than 90 days, file then row", async () => {
    const ticket = await db.supportTicket.create({ data: { email: `t_${sfx}@example.com`, topic: "bug", message: "m" } });
    const providerId = `klecx/test/support/${sfx}`;
    storage.seedFile(providerId, Buffer.from("png"));
    const shot = await db.supportAttachment.create({ data: { ticketId: ticket.id, providerId, mime: "image/png", bytes: 3, createdAt: ago(91 * DAY) } });
    const recent = await db.supportAttachment.create({ data: { ticketId: ticket.id, providerId: `${providerId}-2`, mime: "image/png", bytes: 3, createdAt: ago(10 * DAY) } });
    expect((await purgeSupportScreenshots(NOW)).deleted).toBeGreaterThanOrEqual(1);
    expect(await db.supportAttachment.findUnique({ where: { id: shot.id } })).toBeNull();
    expect(storage.hasFile(providerId)).toBe(false);
    expect(await db.supportAttachment.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await purgeSupportScreenshots(NOW)).toMatchObject({ deleted: 0 });
  });

  test("purge-speech-cache: audio unused for 90 days goes; recently played stays", async () => {
    const mk = (key: string, lastUsedAt: Date) => {
      storage.seedFile(`klecx/test/speech/${key}`, Buffer.from("mp3"));
      return db.speechCache.create({
        data: { key, provider: "gemini", modelId: "m", voiceId: "v", chars: 1, seconds: 1, storageId: `klecx/test/speech/${key}`, mime: "audio/mpeg", bytes: 3, lastUsedAt },
      });
    };
    const old = await mk(`old_${sfx}`, ago(91 * DAY));
    const used = await mk(`used_${sfx}`, ago(DAY));
    expect((await purgeSpeechCache(NOW)).deleted).toBeGreaterThanOrEqual(1);
    expect(await db.speechCache.findUnique({ where: { id: old.id } })).toBeNull();
    expect(storage.hasFile(old.storageId)).toBe(false);
    expect(await db.speechCache.findUnique({ where: { id: used.id } })).not.toBeNull();
    expect(await purgeSpeechCache(NOW)).toMatchObject({ deleted: 0 });
  });

  test("prune-job-runs: history older than 30 days", async () => {
    const job = `test-prune-${sfx}`;
    await db.jobRun.create({ data: { job, status: "SUCCEEDED", startedAt: ago(31 * DAY) } });
    await db.jobRun.create({ data: { job, status: "SUCCEEDED", startedAt: ago(DAY) } });
    expect((await pruneJobRuns(NOW)).deleted).toBeGreaterThanOrEqual(1);
    expect(await db.jobRun.count({ where: { job } })).toBe(1);
    expect((await pruneJobRuns(NOW)).deleted).toBe(0);
  });
});

describe("billing jobs", () => {
  test("refresh-credit-periods: an ended paid plan's credits expire, once", async () => {
    const user = `job_ended_${sfx}`;
    users.push(user);
    await db.user.create({ data: { id: user, name: user, email: `${user}@example.com`, emailVerified: true } });
    await db.creditAccount.create({ data: { userId: user, planBalance: 4000, allowancePlan: "LITE", allowanceKey: `creem:paid:tx_${sfx}` } });
    const first = await refreshCreditPeriods(new Date(), { userIds: [user] });
    expect(first).toMatchObject({ checked: 1, changed: 1, failed: 0 });
    const acc = await db.creditAccount.findUniqueOrThrow({ where: { userId: user } });
    expect(acc.allowancePlan).toBe("FREE");
    expect(acc.planBalance).toBeLessThan(4000);
    // Run twice → same result (the account is FREE now, so it isn't even checked).
    expect(await refreshCreditPeriods(new Date(), { userIds: [user] })).toMatchObject({ checked: 0, changed: 0 });
    expect((await db.creditAccount.findUniqueOrThrow({ where: { userId: user } })).planBalance).toBe(acc.planBalance);
  });

  test("enforce-member-limits: a grace that ended is enforced once", async () => {
    await db.memberLimitGrace.create({ data: { ownerId: OWNER, limit: 0, graceEndsAt: ago(DAY) } });
    expect(await enforceMemberLimits(NOW)).toMatchObject({ enforced: 1, failed: 0 });
    expect((await db.memberLimitGrace.findUniqueOrThrow({ where: { ownerId: OWNER } })).enforcedAt).not.toBeNull();
    expect(await enforceMemberLimits(NOW)).toMatchObject({ due: 0, enforced: 0 });
  });

  test("reconcile-billing: detects drift without changing anything; off when billing isn't configured", async () => {
    const remote: Record<string, Awaited<ReturnType<BillingProvider["getSubscription"]>>> = {
      [`sub_ok_${sfx}`]: { id: `sub_ok_${sfx}`, status: "active", productId: null, currentPeriodStart: null, currentPeriodEnd: new Date("2027-01-01T00:00:00Z"), canceledAt: null },
      [`sub_gone_${sfx}`]: { id: `sub_gone_${sfx}`, status: "canceled", productId: null, currentPeriodStart: null, currentPeriodEnd: null, canceledAt: null },
    };
    const fake = { getSubscription: jest.fn(async (id: string) => remote[id] ?? null) } as unknown as BillingProvider;
    setBillingProviderForTests(fake);
    await db.subscription.create({
      data: { userId: OWNER, plan: "LITE", interval: "month", status: "ACTIVE", providerSubscriptionId: `sub_ok_${sfx}`, currentPeriodEnd: new Date("2027-01-01T00:00:00Z") },
    });
    await db.subscription.create({
      data: { userId: OTHER, plan: "PRO", interval: "month", status: "ACTIVE", providerSubscriptionId: `sub_gone_${sfx}` },
    });
    const before = await db.subscription.findMany({ where: { userId: { in: users } }, orderBy: { userId: "asc" } });
    const out = await reconcileBilling({ userIds: [OWNER, OTHER] });
    expect(out).toMatchObject({ configured: true, checked: 2, drift: 1, failed: 0 });
    expect(await reconcileBilling({ userIds: [OWNER, OTHER] })).toEqual(out);
    expect(await db.subscription.findMany({ where: { userId: { in: users } }, orderBy: { userId: "asc" } })).toEqual(before);

    setBillingProviderForTests(null);
    expect(await reconcileBilling()).toEqual({ configured: false });
  });
});

describe("alerts on jobs", () => {
  test("failed, unfinished and overdue jobs, and billing drift, raise alerts", async () => {
    const at = new Date(Date.now() + 3 * DAY);
    const ids = [
      (await db.jobRun.create({ data: { job: "purge-speech-cache", status: "FAILED", errorCode: "boom", startedAt: new Date(at.getTime() - 60 * MIN) } })).id,
      (await db.jobRun.create({ data: { job: "send-emails", status: "RUNNING", startedAt: new Date(at.getTime() - 20 * MIN) } })).id,
      (await db.jobRun.create({ data: { job: "reap-ask-messages", status: "SUCCEEDED", startedAt: new Date(at.getTime() - 120 * MIN) } })).id,
      (await db.jobRun.create({
        data: { job: "reconcile-billing", status: "SUCCEEDED", startedAt: new Date(at.getTime() - 60 * MIN), finishedAt: new Date(at.getTime() - 59 * MIN), result: { drift: 2 } },
      })).id,
    ];
    try {
      const keys = (await evaluateAlerts(at)).map((a) => a.key);
      expect(keys).toEqual(expect.arrayContaining([
        "job_failed:purge-speech-cache",
        "job_stuck:send-emails",
        "job_overdue:reap-ask-messages",
        "billing_drift",
      ]));
      expect(keys).not.toContain("job_overdue:reconcile-billing");
    } finally {
      await db.jobRun.deleteMany({ where: { id: { in: ids } } });
    }
  });
});

describe("schedules", () => {
  test("the workflow runs exactly the jobs of lib/jobs/schedules.ts, in their groups", () => {
    const yml = fs.readFileSync(path.join(process.cwd(), ".github/workflows/cron.yml"), "utf8");
    const list = (name: string) => (yml.match(new RegExp(`${name}: (.+)`))?.[1] ?? "").trim().split(/\s+/).sort();
    const of = (g: string) => JOB_NAMES.filter((j) => JOB_SCHEDULES[j] === g).sort();
    expect(list("FREQUENT_JOBS")).toEqual(of("frequent"));
    expect(list("HOURLY_JOBS")).toEqual(of("hourly"));
    expect(list("DAILY_JOBS")).toEqual(of("daily"));
    expect(yml).toContain(`"*/${JOB_GROUPS.frequent} * * * *"`);
  });
});
