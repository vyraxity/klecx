/**
 * @jest-environment node
 */
import { db } from "@/server/db/client";
import { regenerateResponse } from "@/server/services/response";
import { setCustomProvider, clearActiveGenerationsForTesting } from "@/server/services/generation";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { setUserPlanOverride } from "@/server/billing/plans";
import type { Actor } from "@/server/auth/session";
import type { AiProvider, GenerateRequest, ImageRequest, ImageResult, StreamEvent } from "@/server/ai";

/**
 * Step 10.5 (carried from F5.7): Regenerate keeps the model of the version
 * being regenerated, and falls back to Fast & Efficient when the workspace
 * owner's plan no longer includes it.
 */
class FakeProvider implements AiProvider {
  id = "gemini" as const;
  async *stream(_req: GenerateRequest): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "Regenerated." };
    yield { type: "usage", inputTokens: 5, outputTokens: 2, estimated: false };
  }
  async generateImage(_req: ImageRequest): Promise<ImageResult> {
    return { bytes: Buffer.from("x"), mime: "image/png" };
  }
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* consume */
  }
}

describe("Step 10.5 — Regenerate keeps the version's model", () => {
  let owner: Actor;
  let workspaceId: string;

  beforeEach(async () => {
    clearActiveGenerationsForTesting();
    setCustomProvider(new FakeProvider());
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const user = await db.user.create({
      data: { id: `regen_model_${unique}`, name: "Owner", email: `regen_model_${unique}@example.com`, emailVerified: true },
    });
    owner = { userId: user.id, email: user.email, role: "USER", sessionId: `sess_${unique}` };
    await createAccountWithFreeGrant(user.id);
    workspaceId = (await db.workspace.create({ data: { ownerId: user.id, title: "Regenerate model" } })).id;
  });

  afterEach(() => {
    setCustomProvider(null);
    setUserPlanOverride(owner.userId, null);
    clearActiveGenerationsForTesting();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function responseWithVersion(modelKey: string) {
    const response = await db.response.create({ data: { workspaceId, createdById: owner.userId, prompt: "Explain" } });
    const version = await db.responseVersion.create({
      data: {
        responseId: response.id,
        number: 1,
        status: "COMPLETE",
        content: "First answer.",
        modelKey,
        providerModelId: "test-model",
        promptVersion: "test",
        createdById: owner.userId,
      },
    });
    await db.response.update({ where: { id: response.id }, data: { activeVersionId: version.id } });
    return response.id;
  }

  async function regenerate(responseId: string) {
    const { stream } = await regenerateResponse(owner, responseId, { idempotencyKey: `regen_${Math.random()}` });
    await drain(stream);
    await new Promise((r) => setTimeout(r, 200));
    const latest = await db.responseVersion.findFirst({ where: { responseId }, orderBy: { number: "desc" } });
    return latest!;
  }

  it("regenerates a Standard Reasoning answer with Standard Reasoning when the owner's plan includes it", async () => {
    setUserPlanOverride(owner.userId, "STANDARD");
    const responseId = await responseWithVersion("text-standard");
    const v2 = await regenerate(responseId);
    expect(v2.number).toBe(2);
    expect(v2.modelKey).toBe("text-standard");
  });

  it("falls back to Fast & Efficient when the owner's plan no longer includes the version's model", async () => {
    setUserPlanOverride(owner.userId, "FREE");
    const responseId = await responseWithVersion("text-standard");
    const v2 = await regenerate(responseId);
    expect(v2.number).toBe(2);
    expect(v2.modelKey).toBe("text-economy");
  });

  it("keeps Fast & Efficient for a Fast & Efficient answer", async () => {
    setUserPlanOverride(owner.userId, "PRO");
    const responseId = await responseWithVersion("text-economy");
    expect((await regenerate(responseId)).modelKey).toBe("text-economy");
  });
});
