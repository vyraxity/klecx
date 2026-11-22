/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db } from "@/server/db/client";
import { auth, isEmailChangeToken } from "@/server/auth/auth";
import { sendEmail } from "@/server/email/send";
import { resetInMemoryRateLimits } from "@/server/http/rate-limit";
import {
  changePassword,
  listLinkedAccounts,
  requestEmailChange,
  unlinkAccount,
} from "@/server/services/account-security";
import { listMySupportTickets } from "@/server/services/support";
import { GET as listLinkedRoute } from "@/app/api/v1/me/linked-accounts/route";
import {
  GET as getLinkedRoute,
  DELETE as unlinkRoute,
} from "@/app/api/v1/me/linked-accounts/[provider]/route";
import { POST as passwordRoute } from "@/app/api/v1/me/password/route";
import { POST as emailRoute } from "@/app/api/v1/me/email/route";
import { GET as ticketsRoute } from "@/app/api/v1/me/support-tickets/route";
import { PATCH as preferencesRoute } from "@/app/api/v1/me/preferences/route";
import { activeSettingsPage, SETTINGS_PAGES } from "@/lib/settings/nav";
import type { Actor } from "@/server/auth/session";

jest.mock("../server/email/send", () => ({
  sendEmail: jest.fn(async () => ({ success: true, id: "msg_1" })),
}));

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => {
  const actual = jest.requireActual("../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});

const suffix = `${Date.now()}`.slice(-7);
const A = { id: `s91_a_${suffix}`, email: `s91_a_${suffix}@example.com` };
const B = { id: `s91_b_${suffix}`, email: `s91_b_${suffix}@example.com` };
const PASSWORD = "Correct-horse-1";

function actorFor(user: { id: string; email: string }, sessionId: string): Actor {
  return { userId: user.id, email: user.email, role: "USER", sessionId } as Actor;
}

function req(url: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function makeSession(userId: string, id: string, createdAt = new Date()) {
  await db.session.create({
    data: {
      id,
      userId,
      token: `tok_${id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt,
    },
  });
}

async function cleanup() {
  const ids = [A.id, B.id];
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.supportTicket.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.account.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await cleanup();
  for (const u of [A, B]) {
    await db.user.create({ data: { id: u.id, email: u.email, name: u.id, emailVerified: true } });
  }
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  mockActor = null;
  resetInMemoryRateLimits();
  (sendEmail as jest.Mock).mockClear();
  await db.session.deleteMany({ where: { userId: { in: [A.id, B.id] } } });
  await db.account.deleteMany({ where: { userId: { in: [A.id, B.id] } } });
});

describe("Step 9.1 — Settings: unauthenticated requests", () => {
  it.each([
    ["GET linked accounts", () => listLinkedRoute(req("/api/v1/me/linked-accounts"))],
    [
      "GET one linked account",
      () => getLinkedRoute(req("/api/v1/me/linked-accounts/google"), { params: Promise.resolve({ provider: "google" }) }),
    ],
    [
      "DELETE a linked account",
      () =>
        unlinkRoute(req("/api/v1/me/linked-accounts/google", "DELETE", {}), {
          params: Promise.resolve({ provider: "google" }),
        }),
    ],
    [
      "POST password",
      () => passwordRoute(req("/api/v1/me/password", "POST", { currentPassword: "x", newPassword: "y".repeat(12) })),
    ],
    ["POST email", () => emailRoute(req("/api/v1/me/email", "POST", { newEmail: "n@example.com" }))],
    ["GET support tickets", () => ticketsRoute(req("/api/v1/me/support-tickets"))],
    ["PATCH preferences", () => preferencesRoute(req("/api/v1/me/preferences", "PATCH", { uiLocale: null }))],
  ])("%s → 401", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
  });
});

describe("Step 9.1 — sign-in methods", () => {
  beforeEach(async () => {
    await db.account.create({
      data: { id: `acc_a_cred_${suffix}`, userId: A.id, accountId: A.id, providerId: "credential", password: await hashPassword(PASSWORD) },
    });
    await db.account.create({
      data: { id: `acc_a_gh_${suffix}`, userId: A.id, accountId: `gh_${suffix}`, providerId: "github" },
    });
    await db.account.create({
      data: { id: `acc_b_gg_${suffix}`, userId: B.id, accountId: `gg_${suffix}`, providerId: "google" },
    });
  });

  it("lists only my own methods and whether I have a password", async () => {
    const a = await listLinkedAccounts(A.id);
    expect(a.methods.map((m) => m.provider).sort()).toEqual(["credential", "github"]);
    expect(a.hasPassword).toBe(true);
    const b = await listLinkedAccounts(B.id);
    expect(b.methods.map((m) => m.provider)).toEqual(["google"]);
    expect(b.hasPassword).toBe(false);
  });

  it("GET /linked-accounts/:provider is 404 for a provider I haven't linked (even if someone else has)", async () => {
    await makeSession(A.id, `sess_a_${suffix}`);
    mockActor = actorFor(A, `sess_a_${suffix}`);
    const res = await getLinkedRoute(req("/api/v1/me/linked-accounts/google"), {
      params: Promise.resolve({ provider: "google" }),
    });
    expect(res.status).toBe(404);
    const unknown = await getLinkedRoute(req("/api/v1/me/linked-accounts/twitter"), {
      params: Promise.resolve({ provider: "twitter" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("another person can't remove my linked account: DELETE only touches the caller's own", async () => {
    await makeSession(A.id, `sess_a_${suffix}`);
    mockActor = actorFor(A, `sess_a_${suffix}`);
    const res = await unlinkRoute(req("/api/v1/me/linked-accounts/google", "DELETE", {}), {
      params: Promise.resolve({ provider: "google" }),
    });
    expect(res.status).toBe(404);
    expect(await db.account.count({ where: { userId: B.id, providerId: "google" } })).toBe(1);
  });

  it("never removes the last way to sign in (409 last_sign_in_method)", async () => {
    await makeSession(B.id, `sess_b_${suffix}`);
    await expect(unlinkAccount(actorFor(B, `sess_b_${suffix}`), "google")).rejects.toMatchObject({
      status: 409,
      code: "last_sign_in_method",
    });
    expect(await db.account.count({ where: { userId: B.id } })).toBe(1);
  });

  it("disconnects GitHub on a fresh session, and records it", async () => {
    await makeSession(A.id, `sess_a_${suffix}`);
    mockActor = actorFor(A, `sess_a_${suffix}`);
    const res = await unlinkRoute(req("/api/v1/me/linked-accounts/github", "DELETE", {}), {
      params: Promise.resolve({ provider: "github" }),
    });
    expect(res.status).toBe(200);
    expect(await db.account.count({ where: { userId: A.id, providerId: "github" } })).toBe(0);
    expect(await db.auditLog.count({ where: { userId: A.id, action: "ACCOUNT_UNLINKED" } })).toBe(1);
  });

  it("an old session needs the password to disconnect", async () => {
    await makeSession(A.id, `sess_old_${suffix}`, new Date(Date.now() - 60 * 60 * 1000));
    const actor = actorFor(A, `sess_old_${suffix}`);
    await expect(unlinkAccount(actor, "github")).rejects.toMatchObject({ code: "FRESH_LOGIN_REQUIRED" });
    await expect(unlinkAccount(actor, "github", "wrong-password")).rejects.toMatchObject({ code: "INVALID_PASSWORD" });
    await expect(unlinkAccount(actor, "github", PASSWORD)).resolves.toMatchObject({ success: true });
  });
});

describe("Step 9.1 — change password", () => {
  beforeEach(async () => {
    await db.account.create({
      data: { id: `acc_a_cred_${suffix}`, userId: A.id, accountId: A.id, providerId: "credential", password: await hashPassword(PASSWORD) },
    });
    await makeSession(A.id, `sess_cur_${suffix}`);
    await makeSession(A.id, `sess_other_${suffix}`);
    await makeSession(B.id, `sess_b_${suffix}`);
  });

  it("refuses a wrong current password (403, nothing changes)", async () => {
    mockActor = actorFor(A, `sess_cur_${suffix}`);
    const res = await passwordRoute(
      req("/api/v1/me/password", "POST", { currentPassword: "nope-nope-nope", newPassword: "A-brand-new-pass" })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("INVALID_PASSWORD");
    expect(await db.session.count({ where: { userId: A.id } })).toBe(2);
  });

  it("rejects a too-short new password (422)", async () => {
    mockActor = actorFor(A, `sess_cur_${suffix}`);
    const res = await passwordRoute(req("/api/v1/me/password", "POST", { currentPassword: PASSWORD, newPassword: "short" }));
    expect(res.status).toBe(422);
  });

  it("changes it, signs out my other devices only, and emails me", async () => {
    mockActor = actorFor(A, `sess_cur_${suffix}`);
    const res = await passwordRoute(
      req("/api/v1/me/password", "POST", { currentPassword: PASSWORD, newPassword: "A-brand-new-pass" })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.revokedSessions).toBe(1);

    const account = await db.account.findFirst({ where: { userId: A.id, providerId: "credential" } });
    expect(await verifyPassword({ hash: account!.password!, password: "A-brand-new-pass" })).toBe(true);
    const sessions = await db.session.findMany({ where: { userId: A.id }, select: { id: true } });
    expect(sessions.map((s) => s.id)).toEqual([`sess_cur_${suffix}`]);
    expect(await db.session.count({ where: { userId: B.id } })).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith("password-changed", A.email, expect.any(Object));
  });

  it("an account without a password gets 409 no_password", async () => {
    await expect(
      changePassword(actorFor(B, `sess_b_${suffix}`), { currentPassword: "x", newPassword: "A-brand-new-pass" })
    ).rejects.toMatchObject({ status: 409, code: "no_password" });
  });
});

describe("Step 9.1 — change email", () => {
  afterEach(() => jest.restoreAllMocks());

  it("starts Better Auth's two-step change with the normalized address", async () => {
    const spy = jest.spyOn(auth.api, "changeEmail").mockResolvedValue({ status: true } as never);
    await requestEmailChange(actorFor(A, "s"), "  New.Address@Example.com ", new Headers());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ newEmail: "new.address@example.com" }),
      })
    );
  });

  it("refuses the same address and throwaway inboxes (422)", async () => {
    const spy = jest.spyOn(auth.api, "changeEmail").mockResolvedValue({ status: true } as never);
    await expect(requestEmailChange(actorFor(A, "s"), A.email.toUpperCase(), new Headers())).rejects.toMatchObject({
      status: 422,
      code: "same_email",
    });
    await expect(requestEmailChange(actorFor(A, "s"), "x@mailinator.com", new Headers())).rejects.toMatchObject({
      status: 422,
      code: "DISPOSABLE_EMAIL",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an invalid address at the route (422)", async () => {
    await makeSession(A.id, `sess_a_${suffix}`);
    mockActor = actorFor(A, `sess_a_${suffix}`);
    const res = await emailRoute(req("/api/v1/me/email", "POST", { newEmail: "not-an-email" }));
    expect(res.status).toBe(422);
  });

  it("recognizes email-change verification tokens (for the email wording)", () => {
    const token = (payload: object) =>
      `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
    expect(isEmailChangeToken(token({ email: "a@x.com", updateTo: "b@x.com", requestType: "change-email-verification" }))).toBe(true);
    expect(isEmailChangeToken(token({ email: "a@x.com" }))).toBe(false);
    expect(isEmailChangeToken("garbage")).toBe(false);
  });
});

describe("Step 9.1 — my support requests", () => {
  beforeAll(async () => {
    await db.supportTicket.create({ data: { userId: A.id, email: A.email, topic: "bug", message: "x".repeat(400) } });
    await db.supportTicket.create({ data: { userId: B.id, email: B.email, topic: "billing", message: "B's ticket" } });
  });

  it("lists only my own tickets, with a short excerpt", async () => {
    const mine = await listMySupportTickets(A.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.topic).toBe("bug");
    expect(mine[0]!.excerpt.length).toBeLessThan(200);
  });

  it("the route never returns someone else's tickets", async () => {
    await makeSession(B.id, `sess_b_${suffix}`);
    mockActor = actorFor(B, `sess_b_${suffix}`);
    const res = await ticketsRoute(req("/api/v1/me/support-tickets"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.tickets.map((t: { topic: string }) => t.topic)).toEqual(["billing"]);
  });
});

describe("Step 9.1 — app language: Automatic clears the saved choice and the cookie", () => {
  afterAll(async () => {
    await db.userPreference.deleteMany({ where: { userId: A.id } });
  });

  it("PATCH uiLocale: null removes the NEXT_LOCALE cookie", async () => {
    await makeSession(A.id, `sess_a_${suffix}`);
    mockActor = actorFor(A, `sess_a_${suffix}`);
    const set = await preferencesRoute(req("/api/v1/me/preferences", "PATCH", { uiLocale: "fr" }));
    expect(set.headers.get("set-cookie")).toContain("NEXT_LOCALE=fr");
    const auto = await preferencesRoute(req("/api/v1/me/preferences", "PATCH", { uiLocale: null }));
    expect(auto.status).toBe(200);
    expect(auto.headers.get("set-cookie")).toMatch(/NEXT_LOCALE=;/);
    const pref = await db.userPreference.findUnique({ where: { userId: A.id } });
    expect(pref?.uiLocale).toBeNull();
  });
});

describe("Step 9.1 — settings navigation", () => {
  it("knows which page a path belongs to", () => {
    expect(activeSettingsPage("/settings/billing")).toBe("billing");
    expect(activeSettingsPage("/settings/language")).toBe("language");
    expect(activeSettingsPage("/settings")).toBeNull();
    expect(activeSettingsPage("/settings/unknown")).toBeNull();
    expect(activeSettingsPage("/workspaces")).toBeNull();
  });

  it("lists only pages that exist (no voice/usage/data until their steps)", () => {
    expect(SETTINGS_PAGES).not.toContain("voice");
    expect(SETTINGS_PAGES).not.toContain("usage");
    expect(SETTINGS_PAGES).not.toContain("data");
    for (const page of SETTINGS_PAGES) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(require("fs").existsSync(`app/(app)/settings/${page}/page.tsx`)).toBe(true);
    }
  });
});
