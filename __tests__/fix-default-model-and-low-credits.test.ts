/**
 * @jest-environment node
 */
/**
 * Pre-10.6 fix PR 1 (owner, 2026-11-27): the default model for new messages
 * (Automatic = Standard Reasoning when the paying plan includes it), the
 * minimum a message needs, the 402's details, and no unreserved search
 * surcharge on an almost empty balance.
 */
import { db } from "@/server/db/client";
import {
  createAndStreamGeneration,
  setCustomProvider,
  clearActiveGenerationsForTesting,
} from "@/server/services/generation";
import { createAccountWithFreeGrant, reserve } from "@/server/services/credits";
import { reserveForWorkspaceGeneration } from "@/server/services/billing-owner";
import { setUserPlanOverride, clearUserPlanOverrides } from "@/server/billing/plans";
import {
  getDefaultModelPreference,
  getUserPreferences,
  updateUserPreferences,
} from "@/server/services/user-preferences";
import { getWorkspace } from "@/server/services/workspace";
import { bestTextModel, resolveDefaultTextModel } from "@/lib/ai/default-model";
import { minimumMessageCredits } from "@/lib/ai/model-catalog";
import type {
  AiProvider,
  GenerateRequest,
  ImageRequest,
  ImageResult,
  StreamEvent,
} from "@/server/ai";
import type { Actor } from "@/server/auth/session";

class MockProvider implements AiProvider {
  id = "gemini" as const;
  public offeredTools: string[] = [];

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    if (req.grounding) {
      yield { type: "text_delta", text: "Search summary." };
      return;
    }
    this.offeredTools = (req.tools ?? []).map((t) => t.name);
    const searched = req.messages.some((m) =>
      m.parts.some((p) => p.type === "tool_response" && p.name === "web_search")
    );
    if (this.offeredTools.includes("web_search") && !searched) {
      yield { type: "tool_call", name: "web_search", args: { query: "current price" } };
      return;
    }
    yield { type: "text_delta", text: "An answer." };
    yield { type: "usage", inputTokens: 100, outputTokens: 50, estimated: false };
  }

  async generateImage(_req: ImageRequest): Promise<ImageResult> {
    throw new Error("unused");
  }
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // read to the end
  }
}

describe("default model rules (shared)", () => {
  test("Automatic is Standard Reasoning when the paying plan includes it", () => {
    expect(bestTextModel(["text-economy", "text-standard"])).toBe("text-standard");
    expect(bestTextModel(["text-economy"])).toBe("text-economy");
    expect(resolveDefaultTextModel(null, ["text-economy", "text-standard"])).toBe("text-standard");
    expect(resolveDefaultTextModel(null, ["text-economy"])).toBe("text-economy");
  });

  test("a saved choice wins when the paying plan includes it, else falls back", () => {
    expect(resolveDefaultTextModel("text-economy", ["text-economy", "text-standard"])).toBe("text-economy");
    expect(resolveDefaultTextModel("text-standard", ["text-economy"])).toBe("text-economy");
    expect(resolveDefaultTextModel("image-standard", ["text-economy", "text-standard"])).toBe("text-standard");
  });

  test("the smallest message needs about 4 (Fast & Efficient) and 16 (Standard Reasoning) credits", () => {
    expect(minimumMessageCredits("text-economy")).toBe(4);
    expect(minimumMessageCredits("text-standard")).toBe(16);
  });
});

describe("default model, credits and search (services)", () => {
  const sfx = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let owner: Actor;
  let member: Actor;
  let workspaceId = "";
  let provider: MockProvider;

  const actorFor = (id: string): Actor => ({ userId: id, email: `${id}@example.com`, role: "USER", sessionId: `s_${id}` }) as Actor;
  const setBalance = async (userId: string, balance: number) =>
    db.creditAccount.update({ where: { userId }, data: { planBalance: balance, topupBalance: 0 } });
  const lastGeneration = () =>
    db.generation.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  const send = (actor: Actor, extra: { modelKey?: string; prompt?: string } = {}) =>
    createAndStreamGeneration(actor, workspaceId, {
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      prompt: extra.prompt ?? "Hello",
      kind: "TEXT",
      ...(extra.modelKey ? { modelKey: extra.modelKey } : {}),
    });

  beforeAll(async () => {
    for (const id of [`dm_owner_${sfx}`, `dm_member_${sfx}`]) {
      await db.user.create({ data: { id, name: id, email: `${id}@example.com`, emailVerified: true } });
      await createAccountWithFreeGrant(id);
    }
    owner = actorFor(`dm_owner_${sfx}`);
    member = actorFor(`dm_member_${sfx}`);
    workspaceId = (await db.workspace.create({ data: { ownerId: owner.userId, title: "Default model" } })).id;
    await db.workspaceMember.create({
      data: { workspaceId, userId: member.userId, role: "EDITOR", invitedById: owner.userId },
    });
  });

  beforeEach(async () => {
    clearActiveGenerationsForTesting();
    clearUserPlanOverrides();
    provider = new MockProvider();
    setCustomProvider(provider);
    await setBalance(owner.userId, 1000);
    await db.userPreference.deleteMany({ where: { userId: { in: [owner.userId, member.userId] } } });
    // No web search unless a test turns it on.
    await updateUserPreferences(owner.userId, { webSearchEnabled: false });
    await updateUserPreferences(member.userId, { webSearchEnabled: false });
  });

  afterAll(async () => {
    setCustomProvider(null);
    clearUserPlanOverrides();
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  });

  test("a saved default must be in the person's own plan", async () => {
    await expect(updateUserPreferences(member.userId, { defaultModelKey: "text-standard" })).rejects.toMatchObject({
      status: 403,
      code: "model_not_in_plan",
    });
    setUserPlanOverride(member.userId, "LITE");
    await updateUserPreferences(member.userId, { defaultModelKey: "text-standard" });
    expect(await getDefaultModelPreference(member.userId)).toBe("text-standard");
    expect((await getUserPreferences(member.userId)).defaultModelKey).toBe("text-standard");
    // Automatic is always allowed.
    await updateUserPreferences(member.userId, { defaultModelKey: null });
    expect(await getDefaultModelPreference(member.userId)).toBeNull();
  });

  test("without a model, a paid owner's message uses Standard Reasoning; Free uses Fast & Efficient", async () => {
    setUserPlanOverride(owner.userId, "LITE");
    await drain((await send(owner)).stream);
    expect((await lastGeneration())?.modelKey).toBe("text-standard");

    clearUserPlanOverrides();
    await drain((await send(owner)).stream);
    expect((await lastGeneration())?.modelKey).toBe("text-economy");
  });

  test("the person's saved default and an explicit model are respected", async () => {
    setUserPlanOverride(owner.userId, "LITE");
    await updateUserPreferences(owner.userId, { defaultModelKey: "text-economy" });
    await drain((await send(owner)).stream);
    expect((await lastGeneration())?.modelKey).toBe("text-economy");

    await drain((await send(owner, { modelKey: "text-standard" })).stream);
    expect((await lastGeneration())?.modelKey).toBe("text-standard");
  });

  test("a member's default follows the owner's plan", async () => {
    // The member is on Free; the owner's Lite plan pays, so Automatic = Standard.
    setUserPlanOverride(owner.userId, "LITE");
    await drain((await send(member)).stream);
    expect((await lastGeneration())?.modelKey).toBe("text-standard");
  });

  test("a refused message says what it needed; the owner's balance only to the owner", async () => {
    await setBalance(owner.userId, 3);
    await expect(send(owner)).rejects.toMatchObject({
      status: 402,
      code: "insufficient_credits",
      details: { needed: expect.any(Number), balance: 3 },
    });

    let memberError: { details?: Record<string, unknown> } | null = null;
    await send(member).catch((err) => {
      memberError = err;
    });
    expect(memberError).toMatchObject({ status: 402, details: { ownerPays: true, needed: expect.any(Number) } });
    expect(memberError!.details).not.toHaveProperty("balance");
  });

  test("reserve() reports what was needed and the balance", async () => {
    await setBalance(member.userId, 7);
    const account = await db.creditAccount.findUniqueOrThrow({ where: { userId: member.userId } });
    await expect(reserve(account.id, 20, `res_details_${sfx}`, { generationId: `gen_details_${sfx}` })).rejects.toMatchObject({
      status: 402,
      details: { needed: 20, balance: 7 },
    });
    await setBalance(owner.userId, 3);
    await expect(
      reserveForWorkspaceGeneration({
        workspace: workspaceId,
        actorId: member.userId,
        amount: 50,
        reservationKey: `res_ws_details_${sfx}`,
        generationId: `gen_ws_details_${sfx}`,
      })
    ).rejects.toMatchObject({ status: 402, details: { needed: 50, ownerPays: true } });
  });

  test("web search isn't offered when the balance left after the reservation can't cover it", async () => {
    setUserPlanOverride(owner.userId, "LITE");
    await updateUserPreferences(owner.userId, { webSearchEnabled: true });

    // Plenty of credits: the search tool is offered (and used).
    await drain((await send(owner, { modelKey: "text-economy" })).stream);
    expect((await lastGeneration())?.usage).toMatchObject({ searches: 1 });

    // A few credits more than the reservation: no search, no unreserved surcharge.
    await setBalance(owner.userId, minimumMessageCredits("text-economy") + 3);
    provider.offeredTools = [];
    await drain((await send(owner, { modelKey: "text-economy" })).stream);
    expect(provider.offeredTools).not.toContain("web_search");
    expect(((await lastGeneration())?.usage as { searches?: number })?.searches ?? 0).toBe(0);
  });

  test("the workspace tells the composer the owner's models and, to the owner only, the balance", async () => {
    setUserPlanOverride(owner.userId, "LITE");
    await setBalance(owner.userId, 10);
    const forOwner = await getWorkspace(owner, workspaceId);
    expect(forOwner.ownerTextModels).toEqual(["text-economy", "text-standard"]);
    expect(forOwner.ownerCanAfford).toEqual({ "text-economy": true, "text-standard": false });
    expect(forOwner.ownerBalance).toBe(10);

    const forMember = await getWorkspace(member, workspaceId);
    expect(forMember.ownerCanAfford).toEqual({ "text-economy": true, "text-standard": false });
    expect(forMember.ownerBalance).toBeNull();
  });
});
