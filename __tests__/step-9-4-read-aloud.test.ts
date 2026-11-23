/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { createAccountWithFreeGrant } from "@/server/services/credits";
import { setUserPlanOverride, clearUserPlanOverrides } from "@/server/billing/plans";
import { setStorageProvider } from "@/server/storage";
import { MockStorageProvider } from "@/server/storage/mock";
import { setNaturalSpeechProviderForTesting } from "@/server/speech/gemini-tts";
import { SpeechProviderError, type SpeechProvider } from "@/server/speech/provider";
import { pcmToWav, wavDurationSeconds, isWav } from "@/server/speech/wav";
import { wavToMp3 } from "@/server/speech/mp3";
import { storagePath } from "@/server/storage";
import {
  prepareReadAloud,
  synthesizeReadAloudSegment,
  previewVoice,
} from "@/server/services/speech";
import { updateUserPreferences } from "@/server/services/user-preferences";
import { markdownToSpeech, chunkSpeech, prepareSpeech, MAX_SEGMENT_CHARS, MAX_SPEECH_CHARS } from "@/lib/speech/prepare";
import { speechCreditsFor } from "@/lib/speech/pricing";
import { POST as prepareRoute } from "@/app/api/v1/speech/route";
import { POST as segmentRoute } from "@/app/api/v1/speech/segment/route";
import { GET as voicesRoute } from "@/app/api/v1/speech/voices/route";
import { POST as previewRoute } from "@/app/api/v1/speech/preview/route";
import { resetInMemoryRateLimits } from "@/server/http/rate-limit";
import type { Actor } from "@/server/auth/session";

let mockActor: Actor | null = null;
jest.mock("../server/auth/session", () => {
  const actual = jest.requireActual("../server/auth/session");
  return { ...actual, getActor: jest.fn(async () => mockActor) };
});

const sfx = `${Date.now()}`.slice(-7);
const A = { id: `u94_a_${sfx}`, email: `u94_a_${sfx}@example.com` }; // owner, Lite
const B = { id: `u94_b_${sfx}`, email: `u94_b_${sfx}@example.com` }; // member, Lite
const C = { id: `u94_c_${sfx}`, email: `u94_c_${sfx}@example.com` }; // outsider
const F = { id: `u94_f_${sfx}`, email: `u94_f_${sfx}@example.com` }; // member, Free
const W = `w94_${sfx}`;
let versionId = "";
let privateMessageId = "";
let documentId = "";

const actor = (u: { id: string; email: string }) => ({ userId: u.id, email: u.email, role: "USER", sessionId: `s_${u.id}` }) as Actor;
const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const OPTS = { codeOmitted: "Code block omitted" };

/** A fake natural voice: one second of silence per 15 characters. */
let calls = 0;
let failNext = false;
const fakeProvider: SpeechProvider = {
  id: "natural",
  modelId: "fake-tts",
  listVoices: () => [],
  async synthesize({ text }) {
    calls++;
    if (failNext) {
      failNext = false;
      throw new SpeechProviderError("down", true);
    }
    const seconds = Math.max(1, Math.round(text.length / 15));
    const audio = pcmToWav(Buffer.alloc(24_000 * 2 * seconds));
    return { audio, mime: "audio/wav", usage: { chars: text.length, audioSeconds: seconds } };
  },
};

async function balance(userId: string) {
  const a = await db.creditAccount.findUniqueOrThrow({ where: { userId } });
  return a.planBalance + a.topupBalance;
}

async function cleanup() {
  const ids = [A.id, B.id, C.id, F.id];
  await db.generation.deleteMany({ where: { actorId: { in: ids } } });
  await db.workspaceMember.deleteMany({ where: { workspaceId: W } });
  await db.workspace.deleteMany({ where: { id: W } });
  await db.creditAccount.deleteMany({ where: { userId: { in: ids } } });
  await db.userPreference.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.speechCache.deleteMany({ where: { modelId: "fake-tts" } });
}

beforeAll(async () => {
  await cleanup();
  setStorageProvider(new MockStorageProvider());
  setNaturalSpeechProviderForTesting(fakeProvider);
  for (const u of [A, B, C, F]) {
    await db.user.create({ data: { id: u.id, email: u.email, name: u.id, emailVerified: true } });
    await createAccountWithFreeGrant(u.id);
  }
  setUserPlanOverride(A.id, "LITE");
  setUserPlanOverride(B.id, "LITE");
  setUserPlanOverride(C.id, "LITE");
  await db.workspace.create({ data: { id: W, ownerId: A.id, title: "Read aloud" } });
  await db.workspaceMember.create({ data: { workspaceId: W, userId: B.id, role: "VIEWER", invitedById: A.id } });
  await db.workspaceMember.create({ data: { workspaceId: W, userId: F.id, role: "VIEWER", invitedById: A.id } });
  const response = await db.response.create({ data: { workspaceId: W, createdById: A.id, prompt: "Explain" } });
  const version = await db.responseVersion.create({
    data: {
      responseId: response.id,
      number: 1,
      modelKey: "text-economy",
      providerModelId: "x",
      promptVersion: "1",
      createdById: A.id,
      content: "# Title\n\nRaft is a consensus algorithm [1]. See [the paper](https://example.com).\n\n```js\nconst x = 1;\n```\n\n| Name | Year |\n|---|---|\n| Raft | 2014 |",
    },
  });
  versionId = version.id;
  const annot = await db.annotation.create({
    data: {
      workspaceId: W,
      createdById: A.id,
      kind: "ASK",
      targetType: "RESPONSE_VERSION",
      versionId,
      responseId: response.id,
      anchorExact: "Raft",
      anchorPrefix: "",
      anchorSuffix: "",
      visibility: "PRIVATE",
    },
  });
  privateMessageId = (
    await db.annotationMessage.create({ data: { annotationId: annot.id, role: "ASSISTANT", content: "A private answer." } })
  ).id;
  const doc = await db.document.create({
    data: { workspaceId: W, versionId, title: "Doc", format: "md", createdById: A.id, currentRevision: 2 },
  });
  documentId = doc.id;
  await db.documentRevision.create({ data: { documentId, revision: 1, content: "First draft." } });
  await db.documentRevision.create({ data: { documentId, revision: 2, content: "Second draft." } });
});

afterAll(async () => {
  clearUserPlanOverrides();
  setNaturalSpeechProviderForTesting(null);
  setStorageProvider(null);
  await cleanup();
});

beforeEach(() => {
  mockActor = null;
  calls = 0;
  failNext = false;
  resetInMemoryRateLimits();
});

describe("Step 9.4 — text preparation", () => {
  it("reads Markdown as speech: code omitted, link text, no citations or URLs, tables as sentences", () => {
    const text = markdownToSpeech(
      "# Title\n\nRaft [1] is **simple**. See [the paper](https://x.y) or https://raw.url.\n\n```ts\ncode()\n```\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |",
      OPTS
    );
    expect(text).toContain("Title.");
    expect(text).toContain("Raft is simple.");
    expect(text).toContain("See the paper or");
    expect(text).toContain("Code block omitted.");
    expect(text).not.toContain("code()");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("[1]");
    expect(text).toContain("one.");
    expect(text).toContain("A, B.");
    expect(text).toContain("1, 2.");
  });

  it("chunks at sentence boundaries within the limit", () => {
    const sentence = "This is one sentence of moderate length for the test. ";
    const chunks = chunkSpeech(sentence.repeat(80));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
      expect(c.endsWith(".")).toBe(true);
    }
  });

  it("caps a request at 20,000 characters", () => {
    const out = prepareSpeech("Sentence here. ".repeat(3000), OPTS);
    expect(out.truncated).toBe(true);
    expect(out.chars).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
  });

  it("WAV helpers and pricing", () => {
    const wav = pcmToWav(Buffer.alloc(24_000 * 2 * 3));
    expect(isWav(wav)).toBe(true);
    expect(wavDurationSeconds(wav)).toBeCloseTo(3, 5);
    // $0.00015/s until 2027: 60 s ≈ $0.009 → 5 credits; from 2027 twice that.
    expect(speechCreditsFor(60, 900, new Date("2026-12-01"))).toBe(5);
    expect(speechCreditsFor(60, 900, new Date("2027-02-01"))).toBe(10);
    expect(speechCreditsFor(0, 10, new Date("2026-12-01"))).toBe(1);
  });

  it("stores audio as MP3, about an eighth of the WAV's size", () => {
    const pcm = Buffer.alloc(24_000 * 2 * 3);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
    const wav = pcmToWav(pcm);
    const mp3 = wavToMp3(wav);
    // An MPEG audio frame starts with 11 set bits.
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1]! & 0xe0).toBe(0xe0);
    // 48 kbps × 3 s ≈ 18 KB (plus encoder padding) instead of 144 KB.
    expect(mp3.length).toBeLessThan(25_000);
    expect(mp3.length).toBeGreaterThan(15_000);
  });

  it("every stored file goes under CLOUDINARY_UPLOAD_FOLDER", () => {
    expect(storagePath("speech", "abc")).toBe("klecx/dev/speech/abc");
    expect(storagePath("/support/", "t1", "x")).toBe("klecx/dev/support/t1/x");
  });
});

describe("Step 9.4 — read-aloud service", () => {
  it("prepares the exact text of each surface", async () => {
    const res = await prepareReadAloud(actor(A), { type: "RESPONSE_VERSION", id: versionId, source: "ORIGINAL" }, OPTS);
    expect(res.provider).toBe("natural");
    expect(res.segments[0]!.text).toContain("Raft is a consensus algorithm.");
    expect(res.segments.some((s) => s.cached)).toBe(false);
    const doc = await prepareReadAloud(actor(A), { type: "DOCUMENT_REVISION", id: documentId }, OPTS);
    expect(doc.segments[0]!.text).toBe("Second draft.");
    const rev1 = await prepareReadAloud(actor(A), { type: "DOCUMENT_REVISION", id: documentId, revision: 1 }, OPTS);
    expect(rev1.segments[0]!.text).toBe("First draft.");
    const ask = await prepareReadAloud(actor(A), { type: "ANNOTATION_MESSAGE", id: privateMessageId }, OPTS);
    expect(ask.segments[0]!.text).toBe("A private answer.");
  });

  it("bills the listener once; the replay is cached and free, for anyone who can read it", async () => {
    const before = await balance(B.id);
    const ownerBefore = await balance(A.id);
    const first = await synthesizeReadAloudSegment(actor(B), { type: "DOCUMENT_REVISION", id: documentId }, 0, OPTS);
    expect(first.cached).toBe(false);
    expect(first.credits).toBe(speechCreditsFor(first.seconds, "Second draft.".length));
    expect(await balance(B.id)).toBe(before - first.credits);
    expect(await balance(A.id)).toBe(ownerBefore); // the workspace owner doesn't pay for read-aloud
    const gen = await db.generation.findFirstOrThrow({ where: { actorId: B.id, kind: "SPEECH" } });
    expect(gen).toMatchObject({ status: "COMPLETED", chargedCredits: first.credits, workspaceId: W });
    const row = await db.speechCache.findFirstOrThrow({ where: { chars: "Second draft.".length } });
    expect(row.mime).toBe("audio/mpeg");
    expect(row.storageId).toMatch(/^klecx\/dev\/speech\/[0-9a-f]{64}$/);

    const replay = await synthesizeReadAloudSegment(actor(A), { type: "DOCUMENT_REVISION", id: documentId }, 0, OPTS);
    expect(replay).toMatchObject({ cached: true, credits: 0 });
    expect(calls).toBe(1);
    expect(await balance(A.id)).toBe(ownerBefore);
  });

  it("someone without access gets 404; a private Ask is only its author's", async () => {
    await expect(prepareReadAloud(actor(C), { type: "RESPONSE_VERSION", id: versionId, source: "ORIGINAL" }, OPTS)).rejects.toMatchObject({ status: 404 });
    await expect(synthesizeReadAloudSegment(actor(C), { type: "DOCUMENT_REVISION", id: documentId }, 0, OPTS)).rejects.toMatchObject({ status: 404 });
    await expect(prepareReadAloud(actor(B), { type: "ANNOTATION_MESSAGE", id: privateMessageId }, OPTS)).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(0);
  });

  it("Free plans get browser voices only; natural synthesis and previews are refused", async () => {
    const prep = await prepareReadAloud(actor(F), { type: "RESPONSE_VERSION", id: versionId, source: "ORIGINAL" }, OPTS);
    expect(prep.provider).toBe("browser");
    await expect(
      synthesizeReadAloudSegment(actor(F), { type: "RESPONSE_VERSION", id: versionId, source: "ORIGINAL" }, 0, OPTS)
    ).rejects.toMatchObject({ status: 403, code: "plan_upgrade_required" });
    await expect(previewVoice(actor(F), "Kore", "Hello")).rejects.toMatchObject({ code: "plan_upgrade_required" });
    await expect(updateUserPreferences(F.id, { voiceProvider: "natural" })).rejects.toMatchObject({ code: "plan_upgrade_required" });
    await expect(updateUserPreferences(F.id, { voiceProvider: "browser", voiceId: "Samantha" })).resolves.toMatchObject({ voiceProvider: "browser" });
  });

  it("refuses unknown natural voices in preferences", async () => {
    await expect(updateUserPreferences(A.id, { voiceProvider: "natural", voiceId: "NotAVoice" })).rejects.toMatchObject({ code: "unknown_voice" });
    await expect(updateUserPreferences(A.id, { voiceProvider: "natural", voiceId: "Kore", voiceSpeed: 1.25 })).resolves.toMatchObject({ voiceId: "Kore", voiceSpeed: 1.25 });
  });

  it("a provider failure releases the credits and asks the player to fall back", async () => {
    const before = await balance(A.id);
    failNext = true;
    await expect(
      synthesizeReadAloudSegment(actor(A), { type: "ANNOTATION_MESSAGE", id: privateMessageId }, 0, OPTS)
    ).rejects.toMatchObject({ status: 503, code: "speech_unavailable" });
    expect(await balance(A.id)).toBe(before);
    expect(await db.speechCache.count({ where: { modelId: "fake-tts", chars: "A private answer.".length } })).toBe(0);
  });

  it("stops at the plan's daily natural-voice seconds", async () => {
    await db.generation.create({
      data: {
        actorId: C.id,
        billedAccountId: (await db.creditAccount.findUniqueOrThrow({ where: { userId: C.id } })).id,
        kind: "SPEECH",
        status: "COMPLETED",
        modelKey: "speech-natural",
        providerModelId: "fake-tts",
        promptVersion: "speech-1",
        idempotencyKey: `seed_${sfx}`,
        usage: { seconds: 1800 }, // Lite: 30 minutes
      },
    });
    await db.workspaceMember.create({ data: { workspaceId: W, userId: C.id, role: "VIEWER", invitedById: A.id } });
    await expect(
      synthesizeReadAloudSegment(actor(C), { type: "RESPONSE_VERSION", id: versionId, source: "ORIGINAL" }, 0, OPTS)
    ).rejects.toMatchObject({ status: 402, code: "daily_read_aloud_limit" });
    await db.workspaceMember.deleteMany({ where: { workspaceId: W, userId: C.id } });
  });

  it("previews are generated once per voice and text, and free", async () => {
    const before = await balance(A.id);
    await previewVoice(actor(A), "Kore", "Hello there.");
    await previewVoice(actor(B), "Kore", "Hello there.");
    expect(calls).toBe(1);
    expect(await balance(A.id)).toBe(before);
  });
});

describe("Step 9.4 — routes", () => {
  it("401 without a session", async () => {
    const target = { type: "RESPONSE_VERSION", id: versionId };
    expect((await prepareRoute(post("/api/v1/speech", { target }))).status).toBe(401);
    expect((await segmentRoute(post("/api/v1/speech/segment", { target, index: 0 }))).status).toBe(401);
    expect((await voicesRoute(new NextRequest("http://localhost:3000/api/v1/speech/voices"))).status).toBe(401);
    expect((await previewRoute(post("/api/v1/speech/preview", { voiceId: "Kore" }))).status).toBe(401);
  });

  it("404 for another user; validates the body; returns the voices overview", async () => {
    mockActor = actor(C);
    expect((await prepareRoute(post("/api/v1/speech", { target: { type: "RESPONSE_VERSION", id: versionId } }))).status).toBe(404);
    expect((await prepareRoute(post("/api/v1/speech", { target: { type: "OTHER", id: "x" } }))).status).toBe(422);
    mockActor = actor(A);
    const res = await prepareRoute(post("/api/v1/speech", { target: { type: "RESPONSE_VERSION", id: versionId } }));
    expect(res.status).toBe(200);
    const voices = await (await voicesRoute(new NextRequest("http://localhost:3000/api/v1/speech/voices"))).json();
    expect(voices.data).toMatchObject({ naturalAllowed: true, dailyLimitSeconds: 1800 });
    expect(voices.data.voices).toHaveLength(30);
    expect(JSON.stringify(voices.data.voices)).not.toMatch(/gemini/i);
  });
});
