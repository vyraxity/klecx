/**
 * @jest-environment node
 *
 * Step 8.6 — abuse operations for the Creem account review:
 * - only admins may suspend / unsuspend / freeze / unfreeze (401 signed out, 403 otherwise),
 *   never another admin or themselves; every change is audited;
 * - a suspended account can't sign in (ACCOUNT_SUSPENDED) and its sessions are revoked;
 * - frozen credits can't be spent (403 credits_frozen) until unfrozen.
 */
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import type { Actor } from "@/server/auth/session";
import { reserve } from "@/server/services/credits";
import { POST as suspendRoute } from "@/app/api/v1/admin/users/[id]/suspend/route";
import { POST as unsuspendRoute } from "@/app/api/v1/admin/users/[id]/unsuspend/route";
import { POST as freezeRoute } from "@/app/api/v1/admin/users/[id]/freeze-credits/route";
import { POST as unfreezeRoute } from "@/app/api/v1/admin/users/[id]/unfreeze-credits/route";

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => ({
  getActor: jest.fn(async () => mockActor),
}));
jest.mock("../server/http/rate-limit", () => {
  const actual = jest.requireActual("../server/http/rate-limit");
  return { ...actual, limit: jest.fn(async () => {}) };
});
jest.mock("../server/email/send", () => ({
  sendEmail: jest.fn(async () => ({ success: true })),
}));

const sfx = Date.now().toString().slice(-7);
const admin = `s86_admin_${sfx}`;
const user = `s86_user_${sfx}`; // email prefix of the signed-up person
const otherAdmin = `s86_admin2_${sfx}`;
const password = "a-long-password-123";
let userEmail = "";

const actorFor = (userId: string, role: Actor["role"] = "USER"): Actor => ({
  userId,
  role,
  sessionId: `sess_${userId}`,
  email: `${userId}@example.com`,
});
const post = (path: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function signIn() {
  const { auth } = await import("@/server/auth/auth");
  return auth.api.signInEmail({ body: { email: userEmail, password } }).then(
    () => "ok",
    (e: { body?: { code?: string } }) => e.body?.code ?? "error"
  );
}

beforeAll(async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  await db.user.createMany({
    data: [
      { id: admin, email: `${admin}@example.com`, name: "Admin", emailVerified: true, role: "ADMIN" },
      { id: otherAdmin, email: `${otherAdmin}@example.com`, name: "Admin 2", emailVerified: true, role: "ADMIN" },
    ],
  });
  // A real password account, so sign-in can be tried.
  const { auth } = await import("@/server/auth/auth");
  userEmail = `${user}@example.com`;
  const res = await auth.api.signUpEmail({ body: { email: userEmail, password, name: "User" } });
  await db.user.update({ where: { id: res.user.id }, data: { emailVerified: true } });
});

afterAll(async () => {
  const u = await db.user.findUnique({ where: { email: userEmail }, select: { id: true } });
  const ids = [admin, otherAdmin, ...(u ? [u.id] : [])];
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.account.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function targetId() {
  return (await db.user.findUniqueOrThrow({ where: { email: userEmail }, select: { id: true } })).id;
}

describe("Step 8.6 — account suspension and credit freeze", () => {
  it("only admins: 401 signed out, 403 for anyone else; admins can't target admins or themselves", async () => {
    const id = await targetId();
    mockActor = null;
    expect((await suspendRoute(post(`/api/v1/admin/users/${id}/suspend`, { reason: "spam" }), ctx(id))).status).toBe(401);
    mockActor = actorFor(id);
    for (const [route, body] of [
      [suspendRoute, { reason: "spam" }],
      [unsuspendRoute, undefined],
      [freezeRoute, { reason: "spam" }],
      [unfreezeRoute, undefined],
    ] as const) {
      expect((await route(post(`/api/v1/admin/users/${id}/x`, body), ctx(id))).status).toBe(403);
    }
    mockActor = actorFor(admin, "ADMIN");
    expect((await suspendRoute(post("/x", { reason: "spam" }), ctx(otherAdmin))).status).toBe(403);
    expect((await suspendRoute(post("/x", { reason: "spam" }), ctx(admin))).status).toBe(403);
    expect((await suspendRoute(post("/x", { reason: "spam" }), ctx("missing"))).status).toBe(404);
    expect(await db.user.findUniqueOrThrow({ where: { id }, select: { suspendedAt: true } })).toEqual({ suspendedAt: null });
  });

  it("suspension: sign-in refused, sessions revoked, audited; unsuspend restores sign-in", async () => {
    const id = await targetId();
    expect(await signIn()).toBe("ok");
    expect(await db.session.count({ where: { userId: id } })).toBeGreaterThan(0);

    mockActor = actorFor(admin, "ADMIN");
    const res = await suspendRoute(post("/x", { reason: "AUP violation: spam" }), ctx(id));
    expect(res.status).toBe(200);
    expect(await db.session.count({ where: { userId: id } })).toBe(0);
    expect(await signIn()).toBe("ACCOUNT_SUSPENDED");
    expect(await db.auditLog.findFirst({ where: { userId: admin, action: "ADMIN_SUSPEND_USER", targetId: id } })).toMatchObject({
      metadata: { reason: "AUP violation: spam", freezeCredits: false },
    });

    expect((await unsuspendRoute(post("/x"), ctx(id))).status).toBe(200);
    expect(await signIn()).toBe("ok");
  });

  it("frozen credits can't be spent until unfrozen; suspending can freeze them too", async () => {
    const id = await targetId();
    const account = await db.creditAccount.findUniqueOrThrow({ where: { userId: id } });
    mockActor = actorFor(admin, "ADMIN");

    expect((await freezeRoute(post("/x", { reason: "card testing" }), ctx(id))).status).toBe(200);
    await expect(reserve(account.id, 1, `s86_r1_${sfx}`, { generationId: `g1_${sfx}` })).rejects.toMatchObject({
      status: 403,
      code: "credits_frozen",
    });
    expect((await unfreezeRoute(post("/x"), ctx(id))).status).toBe(200);
    await expect(reserve(account.id, 1, `s86_r2_${sfx}`, { generationId: `g2_${sfx}` })).resolves.toBeDefined();

    expect((await suspendRoute(post("/x", { reason: "fraud", freezeCredits: true }), ctx(id))).status).toBe(200);
    expect((await db.creditAccount.findUniqueOrThrow({ where: { userId: id } })).frozenAt).not.toBeNull();
    await unsuspendRoute(post("/x"), ctx(id));
    await unfreezeRoute(post("/x"), ctx(id));
  });
});
