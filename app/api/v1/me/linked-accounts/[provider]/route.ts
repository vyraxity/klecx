import { route } from "@/server/http/route";
import { Errors } from "@/server/http/errors";
import { socialProviderSchema, unlinkAccountSchema } from "@/lib/schemas/account-security";
import { getLinkedAccount, unlinkAccount } from "@/server/services/account-security";

function parseProvider(params: Record<string, string>) {
  const parsed = socialProviderSchema.safeParse(params?.provider);
  if (!parsed.success) throw Errors.notFound("Linked account");
  return parsed.data;
}

/** Step 9.1: one linked provider (404 when it isn't linked). */
export const GET = route({
  disableCookieCache: true,
  handler: async ({ actor, params }) => getLinkedAccount(actor.userId, parseProvider(params)),
});

/**
 * Step 9.1: disconnect Google or GitHub. Needs a fresh sign-in or the
 * password; the last sign-in method can't be removed (409 last_sign_in_method).
 * Connecting goes through Better Auth's OAuth flow (`authClient.linkSocial`).
 */
export const DELETE = route({
  disableCookieCache: true,
  body: unlinkAccountSchema,
  handler: async ({ actor, params, body }) =>
    unlinkAccount(actor, parseProvider(params), body?.password),
});
