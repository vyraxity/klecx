/**
 * @jest-environment node
 *
 * Text-only launch (owner decided 2026-11-20): image generation is off unless
 * NEXT_PUBLIC_IMAGE_GENERATION_ENABLED=true. While off:
 * - the server refuses image generations and image regenerations (403 `image_generation_disabled`),
 *   after the usual authorization (another user still gets 404);
 * - entitlements drop the image model and the `images` feature on every plan;
 * - plan features, starters, the FAQ and help articles don't mention images.
 * The image code itself still works when the switch is on (see step-5-4-image-generation).
 */
import { db } from "@/server/db/client";
import {
  createAndStreamGeneration,
  setCustomProvider,
  clearActiveGenerationsForTesting,
} from "@/server/services/generation";
import { regenerateResponse } from "@/server/services/response";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { PLANS, setUserPlanOverride, clearUserPlanOverrides } from "@/server/billing/plans";
import { entitlementsForPlan as serverEntitlementsForPlan } from "@/server/billing/entitlements";
import { entitlementsForPlan as sharedEntitlementsForPlan } from "@/lib/entitlements/shared";
import {
  isImageGenerationEnabled,
  visiblePlanFeatures,
} from "@/lib/features/image-generation";
import { visibleStarterCategories, visibleStarterTemplates } from "@/lib/templates/starter-library";
import { faqAnswerKey } from "@/lib/marketing/faq";
import { applyImageSections, getArticle } from "@/lib/help/articles";
import {
  resetModerationStateForTesting,
  type AiProvider,
  type ImageResult,
  type StreamEvent,
} from "@/server/ai";
import { setStorageProvider, MockStorageProvider } from "@/server/storage";
import { ApiError } from "@/server/http/errors";
import type { Actor } from "@/server/auth/session";

const FLAG = "NEXT_PUBLIC_IMAGE_GENERATION_ENABLED";
const setImages = (on: boolean) => {
  process.env[FLAG] = on ? "true" : "false";
};

class FakeProvider implements AiProvider {
  id = "gemini" as const;
  imageCalls = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "ok" };
    yield { type: "usage", inputTokens: 5, outputTokens: 5, estimated: false };
  }
  async generateImage(): Promise<ImageResult> {
    this.imageCalls += 1;
    return {
      bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]),
      mime: "image/png",
      usage: { images: 1 },
    };
  }
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* read to the end */
  }
}

afterAll(() => setImages(true)); // jest.setup default

describe("Text-only launch — the switch", () => {
  it("is off unless the variable is exactly \"true\"", () => {
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      if (value === undefined) delete process.env[FLAG];
      else process.env[FLAG] = value;
      expect(isImageGenerationEnabled()).toBe(false);
    }
    setImages(true);
    expect(isImageGenerationEnabled()).toBe(true);
  });
});

describe("Text-only launch — entitlements", () => {
  it.each(["FREE", "LITE", "STANDARD", "PRO"] as const)("%s has no image model or feature while off", (plan) => {
    setImages(false);
    for (const ent of [sharedEntitlementsForPlan(plan), serverEntitlementsForPlan(plan)]) {
      expect(ent.models).not.toContain("image-standard");
      expect(ent.features.images).toBe(false);
      expect(ent.limits.images).toBe(false);
    }
  });

  it("paid plans get images back when the switch is on", () => {
    setImages(true);
    expect(serverEntitlementsForPlan("LITE").models).toContain("image-standard");
    expect(sharedEntitlementsForPlan("PRO").features.images).toBe(true);
    expect(sharedEntitlementsForPlan("FREE").features.images).toBe(false);
  });
});

describe("Text-only launch — copy", () => {
  it("plan features drop the image line while off", () => {
    setImages(false);
    expect(visiblePlanFeatures(PLANS.PRO.features)).not.toContain("Plans.PRO.features.images");
    expect(visiblePlanFeatures(PLANS.PRO.features).length).toBe(PLANS.PRO.features.length - 1);
    setImages(true);
    expect(visiblePlanFeatures(PLANS.PRO.features)).toContain("Plans.PRO.features.images");
  });

  it("starters: no image category or image templates while off", () => {
    expect(visibleStarterCategories(false).map((c) => c.id)).not.toContain("image");
    expect(visibleStarterTemplates(false).some((t) => t.mode === "image")).toBe(false);
    expect(visibleStarterTemplates(true).some((t) => t.mode === "image")).toBe(true);
  });

  it("the FAQ credit answer has a text-only variant", () => {
    setImages(false);
    expect(faqAnswerKey("creditDef", true)).toBe("items.creditDef.aTextOnly");
    expect(faqAnswerKey("refund", false)).toBe("items.refund.aLaunchingSoon");
    setImages(true);
    expect(faqAnswerKey("creditDef", true)).toBe("items.creditDef.a");
  });

  it("image sections work inline and around whole lines", () => {
    const raw = "a, {{#images}}images, {{/images}}b\n| x |\n{{#images}}| img |{{/images}}\n| y |\n";
    expect(applyImageSections(raw, false)).toBe("a, b\n| x |\n| y |\n");
    expect(applyImageSections(raw, true)).toBe("a, images, b\n| x |\n| img |\n| y |\n");
  });

  it.each(["en", "es", "fr"])("help articles in %s don't mention creating images while off", (locale) => {
    setImages(false);
    for (const slug of ["getting-started", "credits-and-plans"]) {
      const article = getArticle(locale, slug);
      expect(article?.content).toBeTruthy();
      expect(article!.content).not.toMatch(/\{\{[#/^]?images\}\}/);
      expect(article!.content).not.toMatch(/Create Image|Crear Imagen|Créer une image/);
    }
    setImages(true);
    expect(getArticle(locale, "getting-started")!.content).toMatch(/Create Image|Crear Imagen|Créer une image/);
  });
});

describe("Text-only launch — the server refuses image generation", () => {
  let actor: Actor;
  let other: Actor;
  let workspaceId: string;
  let provider: FakeProvider;

  beforeEach(async () => {
    clearActiveGenerationsForTesting();
    resetModerationStateForTesting();
    clearUserPlanOverrides();
    setStorageProvider(new MockStorageProvider());
    provider = new FakeProvider();
    setCustomProvider(provider);

    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const mk = async (tag: string): Promise<Actor> => {
      const u = await db.user.create({
        data: { id: `tol_${tag}_${unique}`, name: tag, email: `tol_${tag}_${unique}@example.com`, emailVerified: true },
      });
      const acc = await createAccountWithFreeGrant(u.id);
      await db.creditAccount.update({ where: { id: acc.id }, data: { topupBalance: 500 } });
      setUserPlanOverride(u.id, "PRO");
      return { userId: u.id, email: u.email, role: "USER", sessionId: `sess_${tag}_${unique}` };
    };
    actor = await mk("owner");
    other = await mk("other");
    workspaceId = (await db.workspace.create({ data: { ownerId: actor.userId, title: "Text only" } })).id;
  });

  afterEach(() => {
    setCustomProvider(null);
    setStorageProvider(null);
    clearActiveGenerationsForTesting();
    resetModerationStateForTesting();
    clearUserPlanOverrides();
    setImages(true);
  });

  const imageInput = (key: string) => ({
    idempotencyKey: key,
    prompt: "A watercolor mountain at sunrise",
    modelKey: "image-standard",
    kind: "IMAGE" as const,
  });

  it("an image generation is refused with 403 image_generation_disabled, before any credits or calls", async () => {
    setImages(false);
    const ledgerCount = () => db.creditLedger.count({ where: { account: { userId: actor.userId } } });
    const before = await ledgerCount();
    const err = await createAndStreamGeneration(actor, workspaceId, imageInput(`tol_a_${Date.now()}`)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("image_generation_disabled");
    expect(provider.imageCalls).toBe(0);
    expect(await ledgerCount()).toBe(before);
  });

  it("the image model can't be sneaked in on a text request", async () => {
    setImages(false);
    const err = await createAndStreamGeneration(actor, workspaceId, {
      ...imageInput(`tol_b_${Date.now()}`),
      kind: "TEXT",
    }).catch((e) => e);
    expect(err.code).toBe("image_generation_disabled");
  });

  it("another user still gets 404, not a hint about images", async () => {
    setImages(false);
    const err = await createAndStreamGeneration(other, workspaceId, imageInput(`tol_c_${Date.now()}`)).catch((e) => e);
    expect(err.status).toBe(404);
  });

  it("an existing image answer can't be regenerated while off; text keeps working", async () => {
    setImages(true);
    const { stream } = await createAndStreamGeneration(actor, workspaceId, imageInput(`tol_d_${Date.now()}`));
    await drain(stream);
    await new Promise((r) => setTimeout(r, 80));
    const image = await db.response.findFirst({ where: { workspaceId, kind: "IMAGE" } });
    expect(image).toBeTruthy();

    setImages(false);
    const err = await regenerateResponse(actor, image!.id, { idempotencyKey: `tol_e_${Date.now()}` }).catch((e) => e);
    expect(err.code).toBe("image_generation_disabled");

    const text = await createAndStreamGeneration(actor, workspaceId, {
      idempotencyKey: `tol_f_${Date.now()}`,
      prompt: "Summarize consensus algorithms",
      modelKey: "text-economy",
      kind: "TEXT",
    });
    await drain(text.stream);
  });
});
