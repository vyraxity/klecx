/**
 * @jest-environment node
 *
 * Two-factor sign-in (after Step 10.1): setup, sign-in challenge (app code,
 * backup code, trusted device), new backup codes, turning it off, admin reset,
 * and the guards around it. Runs Better Auth for real against the test database.
 */
import { NextRequest } from "next/server";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/auth";
import { resetInMemoryRateLimits } from "@/server/http/rate-limit";
import { ApiError } from "@/server/http/errors";
import type { Actor } from "@/server/auth/session";
import {
  adminResetTwoFactor,
  confirmTwoFactorSetup,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateBackupCodes,
  startTwoFactorSetup,
} from "@/server/services/two-factor";
import {
  manualEntryKey,
  normalizeBackupCode,
  normalizeTotpCode,
  safeNextPath,
} from "@/lib/auth/two-factor";
import { POST as authPost } from "@/app/api/auth/[...all]/route";

const sentEmails: { template: string; to: string; data: Record<string, unknown> }[] = [];
jest.mock("../server/email/send", () => {
  const actual = jest.requireActual("../server/email/send");
  return {
    ...actual,
    sendEmail: jest.fn(async (template: string, to: string, data: Record<string, unknown>) => {
      sentEmails.push({ template, to, data });
      return { success: true, id: "mock" };
    }),
  };
});

const alerts: string[] = [];
jest.mock("../server/services/device", () => {
  const actual = jest.requireActual("../server/services/device");
  return {
    ...actual,
    checkAndAlertNewSignIn: jest.fn(async (s: { id: string }) => {
      alerts.push(s.id);
    }),
  };
});

const sfx = `${Date.now()}`.slice(-7);
const email = `tfa_${sfx}@example.com`;
const password = "correct-horse-battery-staple";
const oauthEmail = `tfa_oauth_${sfx}@example.com`;
const APP = "http://localhost:3000";
let userId = "";
let oauthUserId = "";
let adminId = "";

// ---------------------------------------------------------------------------

function cookiesOf(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    out.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
  return out;
}

const cookieHeader = (jar: Map<string, string>) =>
  [...jar].filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; ");

async function authRequest(path: string, body: unknown, jar = new Map<string, string>()) {
  const res = await authPost(
    new NextRequest(`${APP}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, cookie: cookieHeader(jar) },
      body: JSON.stringify(body),
    })
  );
  for (const [k, v] of cookiesOf(res)) jar.set(k, v);
  const json = await res.json().catch(() => null);
  return { res, json, jar };
}

const signIn = (jar = new Map<string, string>()) => authRequest("/sign-in/email", { email, password }, jar);

/** A fresh session for `userId`: the request headers and the matching actor. */
async function session(): Promise<{ headers: Headers; actor: Actor; jar: Map<string, string> }> {
  const { jar, json } = await signIn();
  expect(json?.twoFactorRedirect).toBeUndefined();
  const token = jar.get("better-auth.session_token")!;
  const raw = decodeURIComponent(token).split(".")[0]!;
  const row = await db.session.findUniqueOrThrow({ where: { token: raw } });
  return {
    headers: new Headers({ cookie: cookieHeader(jar), origin: APP }),
    actor: { userId, role: "USER", sessionId: row.id, email } as Actor,
    jar,
  };
}

async function totpFrom(uri: string): Promise<string> {
  const secret = new URL(uri).searchParams.get("secret")!;
  const raw = new TextDecoder().decode(base32.decode(secret));
  return createOTP(raw, { digits: 6, period: 30 }).totp();
}

async function expectApiError(p: Promise<unknown>, status: number, code: string) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: ApiError) => expect({ status: e.status, code: e.code }).toEqual({ status, code }));
}

let totpUri = "";
let backupCodes: string[] = [];

beforeAll(async () => {
  for (const e of [email, oauthEmail, `tfa_admin_${sfx}@example.com`]) {
    const u = await db.user.findUnique({ where: { email: e } });
    if (u) await db.user.delete({ where: { id: u.id } });
  }
  const res = await auth.api.signUpEmail({ body: { email, password, name: "Two Factor" } });
  userId = res.user.id;
  await db.user.update({ where: { id: userId }, data: { emailVerified: true } });

  oauthUserId = `tfa_oauth_${sfx}`;
  await db.user.create({ data: { id: oauthUserId, email: oauthEmail, name: "OAuth", emailVerified: true } });
  await db.account.create({ data: { id: `tfa_acc_${sfx}`, userId: oauthUserId, accountId: `g-${sfx}`, providerId: "google" } });

  adminId = `tfa_admin_${sfx}`;
  await db.user.create({ data: { id: adminId, email: `tfa_admin_${sfx}@example.com`, name: "Admin", emailVerified: true, role: "ADMIN" } });
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: [userId, adminId] } }, { targetId: userId }] } });
  await db.user.deleteMany({ where: { id: { in: [userId, oauthUserId, adminId] } } });
});

beforeEach(() => {
  resetInMemoryRateLimits();
  sentEmails.length = 0;
});

// ---------------------------------------------------------------------------

describe("helpers", () => {
  test("codes, manual key and the redirect after the challenge", () => {
    expect(normalizeTotpCode("12 34-56 7")).toBe("123456");
    expect(normalizeBackupCode(" AbCdE - 12345 ")).toBe("AbCdE-12345");
    expect(manualEntryKey("otpauth://totp/Klecx:a@b.c?secret=ABCDEFGHIJKL&issuer=Klecx")).toBe("ABCD EFGH IJKL");
    expect(manualEntryKey("not a uri")).toBe("");
    expect(safeNextPath("/settings/billing?subscribe=lite", "/workspaces")).toBe("/settings/billing?subscribe=lite");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null]) {
      expect(safeNextPath(bad, "/workspaces")).toBe("/workspaces");
    }
  });
});

describe("turning it on", () => {
  test("status starts off; an account without a password can't turn it on", async () => {
    expect(await getTwoFactorStatus(userId)).toEqual({ enabled: false, hasPassword: true });
    expect(await getTwoFactorStatus(oauthUserId)).toEqual({ enabled: false, hasPassword: false });
    const oauthActor = { userId: oauthUserId, role: "USER", sessionId: "x", email: oauthEmail } as Actor;
    await expectApiError(startTwoFactorSetup(oauthActor, "whatever", new Headers()), 409, "password_required");
  });

  test("a wrong password is refused (403, never 401)", async () => {
    const { actor, headers } = await session();
    await expectApiError(startTwoFactorSetup(actor, "wrong-password-here", headers), 403, "INVALID_PASSWORD");
  });

  test("setup returns a QR code URI, the key and 10 backup codes, but changes nothing yet", async () => {
    const { actor, headers } = await session();
    const setup = await startTwoFactorSetup(actor, password, headers);
    expect(setup.totpUri).toMatch(/^otpauth:\/\/totp\/Klecx:/);
    expect(setup.manualKey.replace(/\s/g, "")).toBe(new URL(setup.totpUri).searchParams.get("secret"));
    expect(setup.backupCodes).toHaveLength(10);
    totpUri = setup.totpUri;
    backupCodes = setup.backupCodes;
    expect((await getTwoFactorStatus(userId)).enabled).toBe(false);
    // Stored encrypted, not in clear.
    const row = await db.twoFactor.findUniqueOrThrow({ where: { userId } });
    expect(row.verified).toBe(false);
    expect(row.secret).not.toContain(new URL(totpUri).searchParams.get("secret")!);
    expect(row.backupCodes).not.toContain(backupCodes[0]!);
    // Until the first code, signing in still needs no code.
    await session();
  });

  test("a wrong first code is refused; the right one turns it on, logs it and emails", async () => {
    const { actor, headers } = await session();
    await expectApiError(confirmTwoFactorSetup(actor, "000000", headers), 422, "invalid_code");
    expect(await confirmTwoFactorSetup(actor, await totpFrom(totpUri), headers)).toEqual({ enabled: true, hasPassword: true });
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorEnabled).toBe(true);
    expect(await db.auditLog.count({ where: { userId, action: "TWO_FACTOR_ENABLED" } })).toBe(1);
    expect(sentEmails.filter((m) => m.template === "two-factor-changed")).toEqual([
      { template: "two-factor-changed", to: email, data: expect.objectContaining({ kind: "enabled" }) },
    ]);
  });
});

describe("signing in with two-factor on", () => {
  test("the password alone gives no session, only a challenge, and no new-sign-in alert", async () => {
    alerts.length = 0;
    const before = await db.session.count({ where: { userId } });
    const { json, jar } = await signIn();
    expect(json).toEqual(expect.objectContaining({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }));
    expect(jar.get("better-auth.session_token") ?? "").toBe("");
    expect(jar.get("better-auth.two_factor")).toBeTruthy();
    expect(await db.session.count({ where: { userId } })).toBe(before);
    expect(alerts).toEqual([]);
  });

  test("a wrong code fails; the right code signs in (and alerts once)", async () => {
    alerts.length = 0;
    const { jar } = await signIn();
    const wrong = await authRequest("/two-factor/verify-totp", { code: "000000" }, jar);
    expect(wrong.json?.code).toBe("INVALID_CODE");
    const ok = await authRequest("/two-factor/verify-totp", { code: await totpFrom(totpUri) }, jar);
    expect(ok.res.status).toBe(200);
    expect(ok.jar.get("better-auth.session_token")).toBeTruthy();
    expect(alerts).toHaveLength(1);
  });

  test("a backup code works once", async () => {
    const code = backupCodes[0]!;
    const first = await authRequest("/two-factor/verify-backup-code", { code }, (await signIn()).jar);
    expect(first.res.status).toBe(200);
    const again = await authRequest("/two-factor/verify-backup-code", { code }, (await signIn()).jar);
    expect(again.json?.code).toBe("INVALID_BACKUP_CODE");
  });

  test("\"Don't ask again on this device\" skips the code next time on that browser only", async () => {
    const { jar } = await signIn();
    await authRequest("/two-factor/verify-totp", { code: await totpFrom(totpUri), trustDevice: true }, jar);
    const trust = jar.get("better-auth.trust_device");
    expect(trust).toBeTruthy();
    const trusted = await signIn(new Map([["better-auth.trust_device", trust!]]));
    expect(trusted.json?.twoFactorRedirect).toBeUndefined();
    expect(trusted.jar.get("better-auth.session_token")).toBeTruthy();
    expect((await signIn()).json?.twoFactorRedirect).toBe(true);
  });

  test("codes are rate-limited per IP", async () => {
    const { jar } = await signIn();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await authRequest("/two-factor/verify-totp", { code: "000000" }, jar)).res.status;
    expect(last).toBe(429);
  });

  test("the plugin's management endpoints can't be called from the browser", async () => {
    for (const path of ["/two-factor/disable", "/two-factor/enable", "/two-factor/generate-backup-codes", "/two-factor/get-totp-uri"]) {
      const { res } = await authRequest(path, { password });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});

/** A signed-in session while two-factor is on (password + code). */
async function twoFactorSession() {
  resetInMemoryRateLimits();
  const { jar } = await signIn();
  await authRequest("/two-factor/verify-totp", { code: await totpFrom(totpUri) }, jar);
  const raw = decodeURIComponent(jar.get("better-auth.session_token")!).split(".")[0]!;
  const row = await db.session.findUniqueOrThrow({ where: { token: raw } });
  return {
    headers: new Headers({ cookie: cookieHeader(jar), origin: APP }),
    actor: { userId, role: "USER", sessionId: row.id, email } as Actor,
  };
}

describe("managing it", () => {
  test("setup again while on is refused", async () => {
    const { actor, headers } = await twoFactorSession();
    await expectApiError(startTwoFactorSetup(actor, password, headers), 409, "two_factor_already_on");
  });

  test("new backup codes need the password and replace the old ones", async () => {
    const { actor, headers } = await twoFactorSession();
    await expectApiError(regenerateBackupCodes(actor, "wrong-password-here", headers), 403, "INVALID_PASSWORD");
    const { backupCodes: fresh } = await regenerateBackupCodes(actor, password, headers);
    expect(fresh).toHaveLength(10);
    expect(sentEmails.at(-1)?.data).toEqual(expect.objectContaining({ kind: "backupCodes" }));
    resetInMemoryRateLimits();
    const old = await authRequest("/two-factor/verify-backup-code", { code: backupCodes[1]! }, (await signIn()).jar);
    expect(old.json?.code).toBe("INVALID_BACKUP_CODE");
    const ok = await authRequest("/two-factor/verify-backup-code", { code: fresh[0]! }, (await signIn()).jar);
    expect(ok.res.status).toBe(200);
  });

  test("turning it off needs the password and removes the secret, codes and trusted devices", async () => {
    const { actor } = await twoFactorSession();
    await expectApiError(disableTwoFactor(actor, "wrong-password-here"), 403, "INVALID_PASSWORD");
    expect(await disableTwoFactor(actor, password)).toEqual({ enabled: false, hasPassword: true });
    expect(await db.twoFactor.count({ where: { userId } })).toBe(0);
    expect(await db.verification.count({ where: { identifier: { startsWith: "trust-device-" }, value: userId } })).toBe(0);
    expect(sentEmails.at(-1)?.data).toEqual(expect.objectContaining({ kind: "disabled" }));
    expect(await db.auditLog.count({ where: { userId, action: "TWO_FACTOR_DISABLED" } })).toBe(1);
    await session(); // no code asked any more
    await expectApiError(disableTwoFactor(actor, password), 409, "two_factor_not_on");
  });

  test("an admin can reset it for a verified person; others can't", async () => {
    const { actor, headers } = await session();
    const setup = await startTwoFactorSetup(actor, password, headers);
    await confirmTwoFactorSetup(actor, await totpFrom(setup.totpUri), headers);
    sentEmails.length = 0;

    const user = { userId: oauthUserId, role: "USER", sessionId: "x", email: oauthEmail } as Actor;
    await expectApiError(adminResetTwoFactor(user, userId), 403, "forbidden");

    const admin = { userId: adminId, role: "ADMIN", sessionId: "y", email: "admin@example.com" } as Actor;
    expect(await adminResetTwoFactor(admin, userId)).toEqual({ ok: true, wasEnabled: true });
    expect((await getTwoFactorStatus(userId)).enabled).toBe(false);
    expect(await db.auditLog.count({ where: { userId: adminId, action: "ADMIN_RESET_TWO_FACTOR", targetId: userId } })).toBe(1);
    expect(sentEmails.filter((m) => m.template === "two-factor-changed")).toEqual([
      expect.objectContaining({ to: email, data: expect.objectContaining({ kind: "resetBySupport" }) }),
    ]);
    await expectApiError(adminResetTwoFactor(admin, "no-such-user"), 404, "not_found");
  });
});

describe("routes and UI wiring", () => {
  test("Settings routes go through route() and the shared schemas", async () => {
    const fs = await import("fs");
    for (const r of ["", "/setup", "/confirm", "/backup-codes", "/disable"]) {
      const src = fs.readFileSync(`app/api/v1/me/two-factor${r}/route.ts`, "utf8");
      expect([r, src.includes('from "@/server/http/route"')]).toEqual([r, true]);
    }
    const login = fs.readFileSync("components/auth/LoginForm.tsx", "utf8");
    expect(login).toContain("twoFactorRedirect");
    expect(login).toContain("TWO_FACTOR_CHALLENGE_PATH");
    const routes = fs.readFileSync("utils/routes.ts", "utf8");
    expect(routes).toContain("'/auth/two-factor'");
  });
});
