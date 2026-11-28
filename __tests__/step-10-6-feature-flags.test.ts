/**
 * @jest-environment node
 *
 * Step 10.6: feature switches and the AI kill switch (`server/flags.ts`).
 * - `DISABLED_FEATURES` (env) turns features off; unknown keys are refused;
 * - an admin pauses/resumes a feature at runtime (`feature_flags` row + audit log);
 *   resuming never overrides the env; non-admins get 403;
 * - a paused feature is refused with 503 before any credits are reserved, after
 *   the usual authorization (a stranger still gets 404).
 */
import { db } from "@/server/db/client";
import { env, validateEnv } from "@/server/env";
import {
  assertFeature,
  enableRuntimePausesForTesting,
  getFeatureStates,
  isFeatureOn,
  listFeatureFlags,
  resetFeatureFlagCacheForTesting,
  setFeatureFlag,
} from "@/server/flags";
import { FEATURE_KEYS, type FeatureKey } from "@/lib/features/flags";
import {
  createAndStreamGeneration,
  setCustomProvider,
  clearActiveGenerationsForTesting,
} from "@/server/services/generation";
import { resolveWebSearchAccess } from "@/server/services/web-search";
import { createInvitation } from "@/server/services/invitation";
import { createShareLink } from "@/server/services/share";
import { transcribeAudio } from "@/server/services/transcription";
import { startCheckout } from "@/server/services/billing";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { entitlementsForPlan } from "@/server/billing/entitlements";
import { setUserPlanOverride, clearUserPlanOverrides } from "@/server/billing/plans";
import { ApiError } from "@/server/http/errors";
import type { AiProvider, StreamEvent } from "@/server/ai";
import type { Actor } from "@/server/auth/session";
import { auth } from "@/server/auth/auth";

class CountingProvider implements AiProvider {
  id = "gemini" as const;
  calls = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1;
    yield { type: "text_delta", text: "ok" };
    yield { type: "usage", inputTokens: 5, outputTokens: 5, estimated: false };
  }
  async generateImage(): Promise<never> {
    throw new Error("not used");
  }
}

const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
let admin: Actor;
let owner: Actor;
let stranger: Actor;
let workspaceId: string;
let provider: CountingProvider;

async function mkUser(tag: string, role: "USER" | "ADMIN" = "USER"): Promise<Actor> {
  const u = await db.user.create({
    data: { id: `ff_${tag}_${unique}`, name: tag, email: `ff_${tag}_${unique}@example.com`, emailVerified: true, role },
  });
  const acc = await createAccountWithFreeGrant(u.id);
  await db.creditAccount.update({ where: { id: acc.id }, data: { topupBalance: 500 } });
  setUserPlanOverride(u.id, "PRO");
  return { userId: u.id, email: u.email, role, sessionId: `sess_${tag}_${unique}` };
}

async function expectPaused(promise: Promise<unknown>, code: "ai_paused" | "feature_paused", feature?: FeatureKey) {
  const err = (await promise.catch((e: unknown) => e)) as ApiError;
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(503);
  expect(err.code).toBe(code);
  if (feature) expect(err.details).toEqual({ feature });
}

const resumeAll = async () => {
  await db.featureFlag.deleteMany({});
  resetFeatureFlagCacheForTesting();
};

beforeAll(async () => {
  enableRuntimePausesForTesting(true);
  admin = await mkUser("admin", "ADMIN");
  owner = await mkUser("owner");
  stranger = await mkUser("stranger");
  workspaceId = (await db.workspace.create({ data: { ownerId: owner.userId, title: "Flags" } })).id;
});

beforeEach(async () => {
  await resumeAll();
  clearActiveGenerationsForTesting();
  provider = new CountingProvider();
  setCustomProvider(provider);
  setUserPlanOverride(owner.userId, "PRO");
  setUserPlanOverride(stranger.userId, "PRO");
});

afterEach(() => {
  setCustomProvider(null);
  clearActiveGenerationsForTesting();
  (env.DISABLED_FEATURES as FeatureKey[]).length = 0;
});

afterAll(async () => {
  await resumeAll();
  enableRuntimePausesForTesting(false);
  clearUserPlanOverrides();
});

describe("DISABLED_FEATURES (env)", () => {
  const base = {
    APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(40),
    GEMINI_API_KEY: "ci-dummy-key-0000",
    RESEND_API_KEY: "re_dummy",
    EMAIL_FROM: "Klecx <ci@example.com>",
    NODE_ENV: "test",
  };

  it("is empty when unset and parses a comma-separated list", () => {
    expect(validateEnv(base).DISABLED_FEATURES).toEqual([]);
    expect(validateEnv({ ...base, DISABLED_FEATURES: " webSearch, voiceInput ,webSearch" }).DISABLED_FEATURES).toEqual([
      "webSearch",
      "voiceInput",
    ]);
  });

  it("refuses unknown keys (a typo must not leave a feature on silently)", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => validateEnv({ ...base, DISABLED_FEATURES: "webserch" })).toThrow(/DISABLED_FEATURES/);
    spy.mockRestore();
  });

  it("turns a feature off, and an admin's resume doesn't override it", async () => {
    (env.DISABLED_FEATURES as FeatureKey[]).push("webSearch");
    expect(await isFeatureOn("webSearch")).toBe(false);
    const state = await setFeatureFlag(admin, "webSearch", { enabled: true });
    expect(state).toMatchObject({ key: "webSearch", enabled: false, disabledByEnv: true, paused: null });
  });
});

describe("runtime pauses (admins)", () => {
  it("every feature is on by default", async () => {
    const states = await getFeatureStates();
    for (const key of FEATURE_KEYS) expect(states[key]).toBe(true);
  });

  it("pause and resume take effect at once on this instance and are audited", async () => {
    const paused = await setFeatureFlag(admin, "ai", { enabled: false, reason: "provider outage" });
    expect(paused).toMatchObject({ key: "ai", enabled: false, disabledByEnv: false });
    expect(paused.paused).toMatchObject({ reason: "provider outage", byUserId: admin.userId });
    expect(await isFeatureOn("ai")).toBe(false);
    expect((await getFeatureStates()).ai).toBe(false);
    await expectPaused(assertFeature("ai"), "ai_paused", "ai");

    const resumed = await setFeatureFlag(admin, "ai", { enabled: true });
    expect(resumed).toMatchObject({ enabled: true, paused: null });
    expect(await isFeatureOn("ai")).toBe(true);

    const logs = await db.auditLog.findMany({
      where: { userId: admin.userId, targetId: "ai" },
      orderBy: { createdAt: "asc" },
    });
    expect(logs.map((l) => l.action)).toEqual(["FEATURE_PAUSED", "FEATURE_RESUMED"]);
  });

  it("a pause written by another instance is seen once the cache expires", async () => {
    expect(await isFeatureOn("checkout")).toBe(true); // cached: no pause
    await db.featureFlag.create({ data: { key: "checkout", reason: "other instance" } });
    resetFeatureFlagCacheForTesting(); // = FEATURE_FLAG_CACHE_MS elapsed
    expect(await isFeatureOn("checkout")).toBe(false);
  });

  it("lists every feature with its source", async () => {
    await setFeatureFlag(admin, "signups", { enabled: false });
    const list = await listFeatureFlags(admin);
    expect(list.map((f) => f.key)).toEqual([...FEATURE_KEYS]);
    expect(list.find((f) => f.key === "signups")).toMatchObject({ enabled: false, disabledByEnv: false });
    expect(list.find((f) => f.key === "ai")).toMatchObject({ enabled: true, paused: null });
  });

  it("non-admins get 403 and change nothing", async () => {
    await expect(listFeatureFlags(owner)).rejects.toMatchObject({ status: 403 });
    await expect(setFeatureFlag(owner, "ai", { enabled: false })).rejects.toMatchObject({ status: 403 });
    expect(await db.featureFlag.count()).toBe(0);
  });
});

describe("paused features are refused before anything is spent", () => {
  const ledgerCount = () => db.creditLedger.count({ where: { account: { userId: owner.userId } } });
  const textInput = (key: string) => ({
    idempotencyKey: key,
    prompt: "Explain consensus algorithms",
    modelKey: "text-economy",
    kind: "TEXT" as const,
  });

  it("the kill switch refuses a new answer with 503 ai_paused, no credits, no AI call", async () => {
    await setFeatureFlag(admin, "ai", { enabled: false });
    const before = await ledgerCount();
    await expectPaused(createAndStreamGeneration(owner, workspaceId, textInput(`ff_a_${Date.now()}`)), "ai_paused");
    expect(provider.calls).toBe(0);
    expect(await ledgerCount()).toBe(before);
  });

  it("a stranger still gets 404, not a hint that AI is paused", async () => {
    await setFeatureFlag(admin, "ai", { enabled: false });
    const err = await createAndStreamGeneration(stranger, workspaceId, textInput(`ff_b_${Date.now()}`)).catch((e) => e);
    expect(err.status).toBe(404);
  });

  it("answers work again as soon as the pause is lifted", async () => {
    await setFeatureFlag(admin, "ai", { enabled: false });
    await setFeatureFlag(admin, "ai", { enabled: true });
    const { stream } = await createAndStreamGeneration(owner, workspaceId, textInput(`ff_c_${Date.now()}`));
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect(provider.calls).toBeGreaterThan(0);
  });

  it("a paused web search isn't offered (answers are written without searching)", async () => {
    const ent = entitlementsForPlan("PRO");
    expect((await resolveWebSearchAccess(owner.userId, "acct", ent)).allowed).toBe(true);
    await setFeatureFlag(admin, "webSearch", { enabled: false });
    expect(await resolveWebSearchAccess(owner.userId, "acct", ent)).toMatchObject({ allowed: false, reachedDailyCap: false });
  });

  it("voice input is refused by its own switch and by the kill switch", async () => {
    const input = { audioBuffer: Buffer.from("x"), clientMimeType: "audio/webm", durationMs: 1000, actorId: owner.userId };
    await setFeatureFlag(admin, "voiceInput", { enabled: false });
    await expectPaused(transcribeAudio(input), "feature_paused", "voiceInput");
    await setFeatureFlag(admin, "voiceInput", { enabled: true });
    await setFeatureFlag(admin, "ai", { enabled: false });
    await expectPaused(transcribeAudio(input), "ai_paused");
  });

  it("collaboration: new invitations and share links are refused, strangers still get 404", async () => {
    await setFeatureFlag(admin, "collaboration", { enabled: false });
    await expectPaused(
      createInvitation(owner, { workspaceId, emailOrUsername: "someone@example.com", role: "VIEWER" }),
      "feature_paused",
      "collaboration"
    );
    await expectPaused(createShareLink(owner, { workspaceId, scope: "WORKSPACE" } as never), "feature_paused", "collaboration");
    const err = await createShareLink(stranger, { workspaceId, scope: "WORKSPACE" } as never).catch((e) => e);
    expect(err.status).toBe(404);
  });

  it("checkout: new purchases are refused", async () => {
    await setFeatureFlag(admin, "checkout", { enabled: false });
    await expectPaused(
      startCheckout(owner.userId, { plan: "LITE", interval: "month", consentImmediateStart: true } as never, "req_ff"),
      "feature_paused",
      "checkout"
    );
  });
});

describe("sign-ups", () => {
  it("a paused sign-up is refused with SIGNUPS_PAUSED and creates no account", async () => {
    await setFeatureFlag(admin, "signups", { enabled: false });
    const email = `ff_signup_${unique}@example.com`;
    const err = (await auth.api
      .signUpEmail({ body: { email, password: "a-long-test-password-123", name: "New" } })
      .catch((e: unknown) => e)) as { body?: { code?: string } };
    expect(err.body?.code).toBe("SIGNUPS_PAUSED");
    expect(await db.user.count({ where: { email } })).toBe(0);
  });

  it("sign-ups work while the switch is on", async () => {
    const email = `ff_signup_ok_${unique}@example.com`;
    const res = await auth.api.signUpEmail({ body: { email, password: "a-long-test-password-123", name: "New" } });
    expect(res.user.email).toBe(email);
  });
});
