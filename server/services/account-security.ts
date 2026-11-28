import "server-only";
import crypto from "node:crypto";
import { shouldRefusePassword } from "@/server/auth/pwned-passwords";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { APIError } from "better-auth/api";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { auth } from "@/server/auth/auth";
import { Errors } from "@/server/http/errors";
import { limit } from "@/server/http/rate-limit";
import { sendEmail } from "@/server/email/send";
import { isDisposableEmail } from "@/server/auth/disposable-email";
import { verifySensitiveActionAuth } from "@/server/services/session";
import type { Actor } from "@/server/auth/session";
import {
  SET_PASSWORD_CODE_MINUTES,
  SET_PASSWORD_MAX_ATTEMPTS,
  SOCIAL_PROVIDERS,
  type SetPasswordConfirmInput,
  type SignInMethod,
  type SocialProvider,
} from "@/lib/schemas/account-security";

/**
 * Step 9.1: Settings → Security. Sign-in methods (password, Google, GitHub),
 * password change and email change. The person acts on their own account only:
 * every function takes the signed-in actor, never a user id from the client.
 */

/** Social providers this deployment has credentials for (the others can't be connected). */
export function configuredSocialProviders(): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((p) =>
    p === "google" ? Boolean(env.GOOGLE_CLIENT_ID) : Boolean(env.GITHUB_CLIENT_ID)
  );
}

export interface LinkedAccountsDto {
  /** Sign-in methods on the account, oldest first. `credential` = email + password. */
  methods: { provider: SignInMethod; linkedAt: Date }[];
  /** Social providers that can be connected on this deployment. */
  available: SocialProvider[];
  hasPassword: boolean;
}

export async function listLinkedAccounts(userId: string): Promise<LinkedAccountsDto> {
  const accounts = await db.account.findMany({
    where: { userId },
    select: { providerId: true, createdAt: true, password: true },
    orderBy: { createdAt: "asc" },
  });
  const methods = accounts
    .filter((a) => a.providerId === "credential" || (SOCIAL_PROVIDERS as readonly string[]).includes(a.providerId))
    .map((a) => ({ provider: a.providerId as SignInMethod, linkedAt: a.createdAt }));
  return {
    methods,
    available: configuredSocialProviders(),
    hasPassword: accounts.some((a) => a.providerId === "credential" && Boolean(a.password)),
  };
}

/** One linked provider, or 404 when it isn't linked. */
export async function getLinkedAccount(userId: string, provider: SocialProvider) {
  const account = await db.account.findFirst({
    where: { userId, providerId: provider },
    select: { providerId: true, createdAt: true },
  });
  if (!account) throw Errors.notFound("Linked account");
  return { provider: account.providerId as SocialProvider, linkedAt: account.createdAt };
}

/**
 * Disconnects Google or GitHub. A sensitive action (fresh sign-in or the
 * password), and never the last way to sign in.
 */
export async function unlinkAccount(actor: Actor, provider: SocialProvider, password?: string) {
  const accounts = await db.account.findMany({
    where: { userId: actor.userId },
    select: { id: true, providerId: true, password: true },
  });
  const target = accounts.filter((a) => a.providerId === provider);
  if (target.length === 0) throw Errors.notFound("Linked account");

  const remaining = accounts.filter(
    (a) => a.providerId !== provider && (a.providerId !== "credential" || Boolean(a.password))
  );
  if (remaining.length === 0) {
    throw Errors.conflict(
      "This is the only way to sign in to this account",
      "last_sign_in_method"
    );
  }

  await verifySensitiveActionAuth(actor, password);

  await db.$transaction([
    db.account.deleteMany({ where: { userId: actor.userId, providerId: provider } }),
    db.auditLog.create({
      data: { userId: actor.userId, action: "ACCOUNT_UNLINKED", metadata: { provider } },
    }),
  ]);
  return { success: true, provider };
}

/**
 * Changes the password: the current one is required (throttled), the other
 * sessions are signed out, and an email tells the person it happened.
 */
export async function changePassword(
  actor: Actor,
  input: { currentPassword: string; newPassword: string }
) {
  const credential = await db.account.findFirst({
    where: { userId: actor.userId, providerId: "credential" },
    select: { id: true, password: true },
  });
  if (!credential?.password) {
    throw Errors.conflict("This account has no password yet", "no_password");
  }

  await limit("auth:reauth", actor.userId);
  const valid = await verifyPassword({ hash: credential.password, password: input.currentPassword });
  // 403, not 401: a 401 makes route() clear the caller's auth cookies.
  if (!valid) throw Errors.forbidden("Incorrect password", "INVALID_PASSWORD");

  if (input.currentPassword === input.newPassword) {
    throw Errors.unprocessable("The new password is the same as the current one", "same_password");
  }

  // Step 10.1: never accept a password found in a known data breach.
  if (await shouldRefusePassword(input.newPassword)) {
    throw Errors.unprocessable(
      "This password appears in a known data breach",
      "PASSWORD_COMPROMISED"
    );
  }

  const hash = await hashPassword(input.newPassword);
  await db.account.update({ where: { id: credential.id }, data: { password: hash } });

  // Sign out every other device (through Better Auth, so cached copies go too).
  const others = await db.session.findMany({
    where: { userId: actor.userId, id: { not: actor.sessionId } },
    select: { token: true },
  });
  const { internalAdapter } = await auth.$context;
  for (const s of others) await internalAdapter.deleteSession(s.token);

  await db.auditLog.create({
    data: { userId: actor.userId, action: "PASSWORD_CHANGED", metadata: { revokedSessions: others.length } },
  });

  const user = await db.user.findUnique({ where: { id: actor.userId }, select: { email: true } });
  if (user) {
    await sendEmail("password-changed", user.email, {
      time: new Date().toUTCString(),
    }).catch(() => undefined);
  }

  return { success: true, revokedSessions: others.length };
}

/**
 * Pre-10.6 fix (owner, 2026-11-27): an account that signs in only with Google
 * or GitHub adds a password from Settings → Security without leaving the
 * page. Step 1 emails a 6-digit code to the account's address (valid
 * `SET_PASSWORD_CODE_MINUTES`); step 2 takes the code and the new password.
 * The code proves the person still controls the mailbox, like the reset
 * link did. Two-factor can't apply: it needs a password.
 *
 * The code is kept only as a hash, in Better Auth's `verifications` table
 * (identifier `set-password:<userId>`, value `<sha256>:<failed tries>`); a new
 * code replaces the previous one. Sends are limited (`auth:setpw`, 3 an hour).
 */
const SET_PASSWORD_PREFIX = "set-password:";

function hashSetPasswordCode(userId: string, code: string): string {
  return crypto.createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

async function assertHasNoPassword(userId: string) {
  const credential = await db.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true },
  });
  if (credential?.password) {
    throw Errors.conflict("This account already has a password", "already_has_password");
  }
}

export async function startPasswordSet(actor: Actor) {
  await assertHasNoPassword(actor.userId);
  await limit("auth:setpw", actor.userId);

  const user = await db.user.findUnique({ where: { id: actor.userId }, select: { email: true } });
  if (!user) throw Errors.notFound("User");

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const identifier = `${SET_PASSWORD_PREFIX}${actor.userId}`;
  await db.$transaction([
    db.verification.deleteMany({ where: { identifier } }),
    db.verification.create({
      data: {
        id: crypto.randomUUID(),
        identifier,
        value: `${hashSetPasswordCode(actor.userId, code)}:0`,
        expiresAt: new Date(Date.now() + SET_PASSWORD_CODE_MINUTES * 60_000),
      },
    }),
  ]);

  await sendEmail("password-set-code", user.email, { code, minutes: SET_PASSWORD_CODE_MINUTES });
  return { sent: true, expiresInMinutes: SET_PASSWORD_CODE_MINUTES };
}

export async function confirmPasswordSet(actor: Actor, input: SetPasswordConfirmInput) {
  await assertHasNoPassword(actor.userId);
  const identifier = `${SET_PASSWORD_PREFIX}${actor.userId}`;
  const row = await db.verification.findFirst({ where: { identifier }, orderBy: { createdAt: "desc" } });
  if (!row || row.expiresAt.getTime() < Date.now()) {
    if (row) await db.verification.deleteMany({ where: { identifier } });
    throw Errors.badRequest("The code has expired. Ask for a new one.", "code_expired");
  }

  const [storedHash, triesText] = row.value.split(":");
  const tries = Number(triesText) || 0;
  const given = Buffer.from(hashSetPasswordCode(actor.userId, input.code), "hex");
  const stored = Buffer.from(storedHash ?? "", "hex");
  const matches = stored.length === given.length && crypto.timingSafeEqual(stored, given);

  if (!matches) {
    const failed = tries + 1;
    if (failed >= SET_PASSWORD_MAX_ATTEMPTS) {
      // Too many wrong codes: this code is spent; ask for a new one.
      await db.verification.deleteMany({ where: { identifier } });
      throw Errors.badRequest("Too many wrong codes. Ask for a new one.", "code_attempts_exceeded");
    }
    await db.verification.update({ where: { id: row.id }, data: { value: `${storedHash}:${failed}` } });
    throw Errors.badRequest("That code isn't right", "invalid_email_code", {
      attemptsLeft: SET_PASSWORD_MAX_ATTEMPTS - failed,
    });
  }

  // Step 10.1: never accept a password found in a known data breach. The
  // code stays valid, so the person can try another password.
  if (await shouldRefusePassword(input.newPassword)) {
    throw Errors.unprocessable("This password appears in a known data breach", "PASSWORD_COMPROMISED");
  }

  const hash = await hashPassword(input.newPassword);
  await db.$transaction(async (tx) => {
    // A credential row without a password (shouldn't exist) gets one; else a
    // new email-and-password sign-in method, as Better Auth creates it.
    const existing = await tx.account.findFirst({
      where: { userId: actor.userId, providerId: "credential" },
      select: { id: true },
    });
    if (existing) {
      await tx.account.update({ where: { id: existing.id }, data: { password: hash } });
    } else {
      await tx.account.create({
        data: {
          id: crypto.randomUUID(),
          userId: actor.userId,
          providerId: "credential",
          accountId: actor.userId,
          password: hash,
        },
      });
    }
    await tx.verification.deleteMany({ where: { identifier } });
    await tx.auditLog.create({ data: { userId: actor.userId, action: "PASSWORD_SET" } });
  });

  const user = await db.user.findUnique({ where: { id: actor.userId }, select: { email: true } });
  if (user) {
    await sendEmail("password-changed", user.email, {
      time: new Date().toUTCString(),
      set: true,
    }).catch(() => undefined);
  }
  return { success: true };
}

/**
 * Starts an email change. Better Auth emails the **current** address first
 * (approve the change), then the new one (verify it); the address changes
 * only after both. The response is the same whether or not the new address
 * is already taken, so it can't be used to find out who has an account.
 */
export async function requestEmailChange(
  actor: Actor,
  newEmail: string,
  headers: Headers
) {
  const normalized = newEmail.trim().toLowerCase();
  if (normalized === actor.email.toLowerCase()) {
    throw Errors.unprocessable("This is already your email address", "same_email");
  }
  if (isDisposableEmail(normalized)) {
    throw Errors.unprocessable("Disposable email addresses can't be used", "DISPOSABLE_EMAIL");
  }
  await limit("auth:verify", actor.userId);
  try {
    await auth.api.changeEmail({
      body: { newEmail: normalized, callbackURL: "/settings/profile?email=changed" },
      headers,
    });
  } catch (err) {
    if (err instanceof APIError) {
      throw Errors.badRequest("The email change couldn't be started", "email_change_failed");
    }
    throw err;
  }
  return { success: true };
}
