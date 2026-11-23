import "server-only";
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
  SOCIAL_PROVIDERS,
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
