import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { bearer, username } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { sendEmail } from "@/server/email/send";
import { authSecondaryStorage } from "@/server/http/rate-limit";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { isDisposableEmail } from "@/server/auth/disposable-email";
import { isUserSuspended } from "@/server/services/account-moderation";
import { generateUniqueDefaultUsername } from "@/server/services/username";
import { parseDeviceMetadata, checkAndAlertNewSignIn } from "@/server/services/device";
import { welcomeOnUserCreated, welcomeOnUserUpdated } from "@/server/services/welcome";

/**
 * Whether a verification token belongs to an email change (Better Auth puts
 * `requestType` in the token's payload). Only read to pick the email wording;
 * Better Auth verifies the token itself.
 */
export function isEmailChangeToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload?.requestType === "change-email-verification" || Boolean(payload?.updateTo);
  } catch {
    return false;
  }
}

export const auth = betterAuth({
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Step 8.4: Free credits renew monthly, so throwaway inboxes can't sign up.
          if (isDisposableEmail(user.email)) {
            throw new APIError("BAD_REQUEST", {
              message: "Disposable email addresses can't be used",
              code: "DISPOSABLE_EMAIL",
            });
          }
          let u = (user as { username?: string }).username;
          if (!u) {
            u = await generateUniqueDefaultUsername();
          }
          return {
            data: {
              ...user,
              username: u,
              displayUsername:
                (user as { displayUsername?: string }).displayUsername || u,
            },
          };
        },
        after: async (user, ctx) => {
          await createAccountWithFreeGrant(user.id);
          // Awaited (it never throws): a promise left running after the
          // response can be cut off on serverless, after the row was claimed.
          await welcomeOnUserCreated(user, ctx);
        },
      },
      update: {
        after: async (user, ctx) => {
          await welcomeOnUserUpdated(user, ctx);
        },
      },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          // Step 8.6: a suspended account can't sign in (any method).
          if (await isUserSuspended(session.userId)) {
            throw new APIError("FORBIDDEN", {
              message: "This account is suspended",
              code: "ACCOUNT_SUSPENDED",
            });
          }
          const country =
            ctx?.headers?.get?.("x-vercel-ip-country") ||
            ctx?.headers?.get?.("cf-ipcountry") ||
            ctx?.headers?.get?.("x-country") ||
            ctx?.headers?.get?.("x-geo-country") ||
            null;
          const clientHeader = ctx?.headers?.get?.("x-client") || null;
          const customDevice = ctx?.headers?.get?.("x-device-name") || null;
          const meta = parseDeviceMetadata(
            session.userAgent,
            customDevice,
            clientHeader
          );

          return {
            data: {
              ...session,
              country:
                country ||
                (session as { country?: string }).country ||
                null,
              deviceLabel: meta.deviceLabel,
              client: meta.client,
            },
          };
        },
        after: async (session) => {
          await checkAndAlertNewSignIn(session);
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/update-user") {
        if (
          ctx.body &&
          typeof ctx.body === "object" &&
          ("username" in ctx.body || "displayUsername" in ctx.body)
        ) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Username cannot be updated via this endpoint. Use /api/v1/me/username.",
          });
        }
      }
    }),
  },
  secondaryStorage: authSecondaryStorage,
  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 3600, max: 5 },
      "/forget-password": { window: 3600, max: 3 },
      "/send-verification-email": { window: 3600, max: 3 },
    },
    customStorage: {
      async consume(key, rule) {
        // Better Auth keys limits as `${ip}|${path}`.
        // Paths handled by enforceAuthRateLimit() in app/api/auth/[...all]/route.ts
        // are already rate-limited with per-client / per-email keys.
        // Also avoid shared fallback buckets ("127.0.0.1" / "no-trusted-ip") when
        // TRUST_PROXY is disabled or no trusted proxy header is present.
        const [ipPart, pathPart] = key.split("|");
        if (
          pathPart === "/sign-in/email" ||
          pathPart === "/sign-up/email" ||
          pathPart === "/forget-password" ||
          pathPart === "/request-password-reset" ||
          pathPart === "/send-verification-email" ||
          !env.TRUST_PROXY ||
          !ipPart ||
          ipPart === "127.0.0.1" ||
          ipPart === "no-trusted-ip"
        ) {
          return { allowed: true, retryAfter: null };
        }
        const count = await authSecondaryStorage.increment(
          `rl:${key}`,
          rule.window
        );
        if (count <= rule.max) {
          return { allowed: true, retryAfter: null };
        }
        return { allowed: false, retryAfter: rule.window };
      },
    },
  },
  advanced: {
    ipAddress: {
      ipAddressHeaders: env.TRUST_PROXY ? ["x-forwarded-for", "x-real-ip"] : [],
    },
  },
  trustedOrigins: [env.APP_URL],
  user: {
    // Step 9.1: email change from Settings → Profile. The current (verified)
    // address approves it first, then the new address is verified; the email
    // changes only after both (Better Auth's two-step flow).
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        await sendEmail("change-email-confirm", user.email, { url, newEmail });
      },
    },
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "USER",
        input: false,
      },
      usernameClaimedAt: {
        type: "date",
        required: false,
        input: false,
      },
      usernameChangeCount: {
        type: "number",
        required: false,
        defaultValue: 0,
        input: false,
      },
      // Step 8.6: read by getActor (a suspended person counts as signed out).
      suspendedAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail("reset-password", user.email, { url });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url, token }) => {
      // Step 9.1: the second step of an email change verifies the new address.
      if (isEmailChangeToken(token)) {
        await sendEmail("change-email-verify", user.email, { url });
        return;
      }
      await sendEmail("verify-email", user.email, { url });
    },
  },
  socialProviders: {
    ...(env.GITHUB_CLIENT_ID && {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
      },
    }),
    ...(env.GOOGLE_CLIENT_ID && {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
      },
    }),
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github"],
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    storeSessionInDatabase: true,
    cookieCache: {
      enabled: false,
    },
    additionalFields: {
      country: {
        type: "string",
        required: false,
        input: false,
      },
      deviceLabel: {
        type: "string",
        required: false,
        input: false,
      },
      client: {
        type: "string",
        required: false,
        defaultValue: "web",
        input: false,
      },
    },
  },
  verification: {
    storeInDatabase: true,
  },
  plugins: [
    bearer(),
    nextCookies(),
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      usernameValidator: (u) =>
        /^[a-z][a-z0-9_]{2,29}$/.test(u) && !u.includes("__"),
    }),
  ],
});
