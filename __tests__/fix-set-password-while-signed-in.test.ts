/**
 * @jest-environment node
 */
/**
 * Pre-10.6 fix PR 5 (owner, 2026-11-27): an account without a password
 * (Google/GitHub sign-in) adds one in Settings → Security with a 6-digit code
 * emailed to it; a password-reset link opens even when signed in.
 */
import { NextRequest } from "next/server";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db } from "@/server/db/client";
import { sendEmail } from "@/server/email/send";
import { resetInMemoryRateLimits } from "@/server/http/rate-limit";
import { confirmPasswordSet, startPasswordSet } from "@/server/services/account-security";
import { POST as startRoute } from "@/app/api/v1/me/password/set/start/route";
import { POST as confirmRoute } from "@/app/api/v1/me/password/set/confirm/route";
import { proxy } from "@/proxy";
import { SET_PASSWORD_MAX_ATTEMPTS } from "@/lib/schemas/account-security";
import type { Actor } from "@/server/auth/session";

jest.mock("../server/email/send", () => ({
  sendEmail: jest.fn(async () => ({ success: true, id: "msg_1" })),
}));

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => {
  const actual = jest.requireActual("../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});

const sfx = `${Date.now()}`.slice(-7);
const OAUTH = { id: `spw_oauth_${sfx}`, email: `spw_oauth_${sfx}@example.com` };
const WITH_PW = { id: `spw_pw_${sfx}`, email: `spw_pw_${sfx}@example.com` };
const NEW_PASSWORD = "A-new-long-passphrase-7";

const actorFor = (u: { id: string; email: string }): Actor =>
  ({ userId: u.id, email: u.email, role: "USER", sessionId: `s_${u.id}` }) as Actor;

/** The code from the last "password-set-code" email. */
function lastCode(): string {
  const calls = (sendEmail as jest.Mock).mock.calls.filter((c) => c[0] === "password-set-code");
  return (calls.at(-1)![2] as { code: string }).code;
}

function req(url: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function cleanup() {
  const ids = [OAUTH.id, WITH_PW.id];
  await db.verification.deleteMany({ where: { identifier: { in: ids.map((id) => `set-password:${id}`) } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.account.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await cleanup();
  for (const u of [OAUTH, WITH_PW]) {
    await db.user.create({ data: { id: u.id, email: u.email, name: u.id, emailVerified: true } });
  }
});

afterAll(cleanup);

beforeEach(async () => {
  mockActor = null;
  resetInMemoryRateLimits();
  (sendEmail as jest.Mock).mockClear();
  await db.account.deleteMany({ where: { userId: { in: [OAUTH.id, WITH_PW.id] } } });
  await db.verification.deleteMany({
    where: { identifier: { in: [OAUTH.id, WITH_PW.id].map((id) => `set-password:${id}`) } },
  });
  // The OAuth account signs in with Google only; the other has a password.
  await db.account.create({
    data: { id: `acc_g_${sfx}`, userId: OAUTH.id, providerId: "google", accountId: `g_${sfx}` },
  });
  await db.account.create({
    data: {
      id: `acc_pw_${sfx}`,
      userId: WITH_PW.id,
      providerId: "credential",
      accountId: WITH_PW.id,
      password: await hashPassword("Existing-passphrase-1"),
    },
  });
});

describe("adding a password with an emailed code", () => {
  test("the code is emailed, kept only as a hash, and sets the password", async () => {
    const res = await startPasswordSet(actorFor(OAUTH));
    expect(res).toEqual({ sent: true, expiresInMinutes: 10 });
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect((sendEmail as jest.Mock).mock.calls.at(-1)![1]).toBe(OAUTH.email);

    const row = await db.verification.findFirst({ where: { identifier: `set-password:${OAUTH.id}` } });
    expect(row?.value).not.toContain(code);

    await expect(confirmPasswordSet(actorFor(OAUTH), { code, newPassword: NEW_PASSWORD })).resolves.toEqual({
      success: true,
    });

    const credential = await db.account.findFirst({ where: { userId: OAUTH.id, providerId: "credential" } });
    expect(credential?.accountId).toBe(OAUTH.id);
    expect(await verifyPassword({ hash: credential!.password!, password: NEW_PASSWORD })).toBe(true);
    // The Google sign-in is still there.
    expect(await db.account.count({ where: { userId: OAUTH.id, providerId: "google" } })).toBe(1);
    // The code is spent.
    expect(await db.verification.count({ where: { identifier: `set-password:${OAUTH.id}` } })).toBe(0);
    expect(await db.auditLog.count({ where: { userId: OAUTH.id, action: "PASSWORD_SET" } })).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith("password-changed", OAUTH.email, expect.objectContaining({ set: true }));
  });

  test("an account that already has a password is refused", async () => {
    await expect(startPasswordSet(actorFor(WITH_PW))).rejects.toMatchObject({
      status: 409,
      code: "already_has_password",
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test(`a wrong code counts down; after ${SET_PASSWORD_MAX_ATTEMPTS} it is spent`, async () => {
    await startPasswordSet(actorFor(OAUTH));
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < SET_PASSWORD_MAX_ATTEMPTS; i++) {
      await expect(confirmPasswordSet(actorFor(OAUTH), { code: wrong, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
        status: 400,
        code: "invalid_email_code",
        details: { attemptsLeft: SET_PASSWORD_MAX_ATTEMPTS - i },
      });
    }
    await expect(confirmPasswordSet(actorFor(OAUTH), { code: wrong, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "code_attempts_exceeded",
    });
    // Even the right code no longer works.
    await expect(confirmPasswordSet(actorFor(OAUTH), { code, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "code_expired",
    });
    expect(await db.account.count({ where: { userId: OAUTH.id, providerId: "credential" } })).toBe(0);
  });

  test("an expired code is refused; a new code replaces the old one", async () => {
    await startPasswordSet(actorFor(OAUTH));
    const first = lastCode();
    await db.verification.updateMany({
      where: { identifier: `set-password:${OAUTH.id}` },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(confirmPasswordSet(actorFor(OAUTH), { code: first, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      code: "code_expired",
    });

    await startPasswordSet(actorFor(OAUTH));
    await startPasswordSet(actorFor(OAUTH));
    expect(await db.verification.count({ where: { identifier: `set-password:${OAUTH.id}` } })).toBe(1);
    // A fourth code within the hour is refused (3 an hour).
    await expect(startPasswordSet(actorFor(OAUTH))).rejects.toMatchObject({ status: 429 });
  });

  test("the routes need a signed-in person and check the input", async () => {
    expect((await startRoute(req("/api/v1/me/password/set/start"))).status).toBe(401);
    expect((await confirmRoute(req("/api/v1/me/password/set/confirm", { code: "123456", newPassword: NEW_PASSWORD }))).status).toBe(401);

    mockActor = actorFor(OAUTH);
    expect((await confirmRoute(req("/api/v1/me/password/set/confirm", { code: "12ab", newPassword: NEW_PASSWORD }))).status).toBe(422);
    expect((await confirmRoute(req("/api/v1/me/password/set/confirm", { code: "123456", newPassword: "short" }))).status).toBe(422);
    const started = await startRoute(req("/api/v1/me/password/set/start"));
    expect(started.status).toBe(200);
  });
});

describe("password-reset link while signed in", () => {
  const SESSION = "better-auth.session_token=abc.def";

  test("opens instead of sending the person to the dashboard", async () => {
    const res = await proxy(
      new NextRequest("http://localhost:3000/auth/reset-password?token=t1", { headers: { cookie: SESSION } })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("other sign-in pages still send a signed-in person to the dashboard", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/auth/login", { headers: { cookie: SESSION } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/workspaces");
  });
});
