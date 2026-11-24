import "server-only";
import { recordLimitHit } from "@/server/monitoring/limit-hits";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/server/db/generated/client";
import { db } from "@/server/db/client";
import { ApiError, Errors } from "@/server/http/errors";
import { requireWorkspace } from "@/server/authz/access";
import { getEntitlements } from "@/server/billing/entitlements";
import { getStorageProvider, storagePath } from "@/server/storage";
import {
  createAccountWithFreeGrant,
  getAccountByUserId,
  release,
  reserve,
  settle,
} from "@/server/services/credits";
import { getUserPreferences } from "@/server/services/user-preferences";
import { getNaturalSpeechProvider } from "@/server/speech/gemini-tts";
import { SpeechProviderError } from "@/server/speech/provider";
import { wavToMp3 } from "@/server/speech/mp3";
import type { Actor } from "@/server/auth/session";
import { prepareSpeech } from "@/lib/speech/prepare";
import { estimateAudioSeconds, speechCreditsFor } from "@/lib/speech/pricing";
import {
  DEFAULT_NATURAL_VOICE,
  MAX_VOICE_SPEED,
  MIN_VOICE_SPEED,
  NATURAL_VOICES,
  isNaturalVoice,
  type VoiceProvider,
} from "@/lib/speech/voices";
import type { SpeechTarget } from "@/lib/schemas/speech";

/**
 * Step 9.4: read-aloud.
 *
 * - The text is always read from the database with the viewer's permissions
 *   (workspace.read, and private Ask threads only for their author): the
 *   browser never sends the text to synthesize. No access → 404.
 * - Natural voices (plan with `naturalVoices`) are synthesized per segment,
 *   cached by sha256(text, provider, model, voice) and shared: a replay, by
 *   anyone, is free and calls no provider. Speed is applied when playing, so
 *   it isn't part of the key.
 * - A miss is billed to the person listening (like voice input), from the
 *   real audio length (lib/speech/pricing.ts), within their plan's daily
 *   seconds (`readAloudSecondsPerDay`).
 * - Browser voices are spoken by the browser: the server only prepares the
 *   segments (no provider, no credits).
 */

const SIGNED_URL_SECONDS = 60 * 60;
const PREVIEW_SPEAKER = "preview";

export interface ReadAloudTextResult {
  workspaceId: string;
  markdown: string;
}

/** The exact text the viewer sees for a target, or 404. */
export async function resolveSpeechText(actor: Actor, target: SpeechTarget): Promise<ReadAloudTextResult> {
  if (target.type === "RESPONSE_VERSION") {
    const version = await db.responseVersion.findUnique({
      where: { id: target.id },
      select: { id: true, content: true, response: { select: { workspaceId: true, deletedAt: true } } },
    });
    if (!version || version.response.deletedAt) throw Errors.notFound("ResponseVersion");
    await requireWorkspace(actor, version.response.workspaceId, "workspace.read");
    let markdown = version.content;
    if (target.source === "EDIT") {
      const edit = await db.responseEdit.findFirst({
        where: { versionId: version.id, ...(target.editRevision !== undefined && { revision: target.editRevision }) },
        orderBy: { revision: "desc" },
        select: { content: true },
      });
      if (!edit) throw Errors.notFound("ResponseEdit");
      markdown = edit.content;
    }
    return { workspaceId: version.response.workspaceId, markdown };
  }

  if (target.type === "ANNOTATION_MESSAGE") {
    const message = await db.annotationMessage.findUnique({
      where: { id: target.id },
      select: {
        content: true,
        annotation: { select: { workspaceId: true, deletedAt: true, visibility: true, createdById: true } },
      },
    });
    if (!message || message.annotation.deletedAt) throw Errors.notFound("AnnotationMessage");
    await requireWorkspace(actor, message.annotation.workspaceId, "workspace.read");
    if (message.annotation.visibility === "PRIVATE" && message.annotation.createdById !== actor.userId) {
      throw Errors.notFound("AnnotationMessage");
    }
    return { workspaceId: message.annotation.workspaceId, markdown: message.content };
  }

  const doc = await db.document.findUnique({
    where: { id: target.id },
    select: { workspaceId: true, deletedAt: true, currentRevision: true },
  });
  if (!doc || doc.deletedAt) throw Errors.notFound("Document");
  await requireWorkspace(actor, doc.workspaceId, "workspace.read");
  const revision = await db.documentRevision.findUnique({
    where: { documentId_revision: { documentId: target.id, revision: target.revision ?? doc.currentRevision } },
    select: { content: true },
  });
  if (!revision) throw Errors.notFound("DocumentRevision");
  return { workspaceId: doc.workspaceId, markdown: revision.content };
}

export interface VoiceSettings {
  provider: VoiceProvider;
  voiceId: string | null;
  speed: number;
  naturalAllowed: boolean;
}

/** The voice to use: the person's choice, limited to what their plan allows. */
export async function resolveVoiceSettings(userId: string): Promise<VoiceSettings> {
  const [prefs, entitlements] = await Promise.all([getUserPreferences(userId), getEntitlements(userId)]);
  const naturalAllowed = entitlements.features.naturalVoices;
  const wanted = prefs.voiceProvider === "browser" ? "browser" : prefs.voiceProvider === "natural" ? "natural" : null;
  const provider: VoiceProvider = naturalAllowed && wanted !== "browser" ? "natural" : "browser";
  const voiceId =
    provider === "natural"
      ? isNaturalVoice(prefs.voiceId) ? prefs.voiceId! : DEFAULT_NATURAL_VOICE
      : prefs.voiceProvider === "browser"
        ? prefs.voiceId
        : null;
  const speed = Math.min(Math.max(prefs.voiceSpeed || 1, MIN_VOICE_SPEED), MAX_VOICE_SPEED);
  return { provider, voiceId, speed, naturalAllowed };
}

export function speechCacheKey(text: string, modelId: string, voiceId: string): string {
  // "mp3": the stored format (WAV files from before the switch are never reused).
  return createHash("sha256").update(JSON.stringify(["natural", "mp3", modelId, voiceId, text])).digest("hex");
}

export interface PreparedReadAloud {
  provider: VoiceProvider;
  voiceId: string | null;
  speed: number;
  truncated: boolean;
  segments: { index: number; text: string; chars: number; cached: boolean }[];
}

/** Step 1: the segments to read (and, for natural voices, which are already cached). */
export async function prepareReadAloud(
  actor: Actor,
  target: SpeechTarget,
  options: { codeOmitted: string; voiceId?: string }
): Promise<PreparedReadAloud> {
  const [{ markdown }, voice] = await Promise.all([resolveSpeechText(actor, target), resolveVoiceSettings(actor.userId)]);
  const { segments, truncated } = prepareSpeech(markdown, { codeOmitted: options.codeOmitted });
  const voiceId = voice.provider === "natural" && options.voiceId && isNaturalVoice(options.voiceId) ? options.voiceId : voice.voiceId;

  let cachedKeys = new Set<string>();
  if (voice.provider === "natural" && voiceId && segments.length > 0) {
    const modelId = getNaturalSpeechProvider().modelId;
    const keys = segments.map((s) => speechCacheKey(s, modelId, voiceId));
    const hits = await db.speechCache.findMany({ where: { key: { in: keys } }, select: { key: true } });
    cachedKeys = new Set(hits.map((h) => h.key));
    return {
      ...voice,
      voiceId,
      truncated,
      segments: segments.map((text, index) => ({
        index,
        text,
        chars: text.length,
        cached: cachedKeys.has(keys[index]!),
      })),
    };
  }
  return {
    provider: voice.provider,
    voiceId,
    speed: voice.speed,
    truncated,
    segments: segments.map((text, index) => ({ index, text, chars: text.length, cached: false })),
  };
}

/** Natural-voice seconds `actorId` generated today (UTC), from SPEECH calls that didn't fail. */
export async function countReadAloudSecondsToday(
  actorId: string,
  client: Pick<Prisma.TransactionClient, "generation"> = db
): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await client.generation.findMany({
    where: { actorId, kind: "SPEECH", status: { not: "FAILED" }, createdAt: { gte: start } },
    select: { usage: true },
  });
  let total = 0;
  for (const r of rows) {
    const s = r.usage && typeof r.usage === "object" && !Array.isArray(r.usage) ? (r.usage as { seconds?: unknown }).seconds : 0;
    if (typeof s === "number" && Number.isFinite(s) && s > 0) total += s;
  }
  return total;
}

function dailyLimitError() {
  return new ApiError(402, "daily_read_aloud_limit", "Daily natural-voice limit reached for your plan");
}

async function signedUrl(storageId: string, mime: string): Promise<string> {
  return getStorageProvider().privateUrl(storageId, {
    resourceType: "video",
    expiresInSeconds: SIGNED_URL_SECONDS,
    format: mime === "audio/wav" ? "wav" : "mp3",
  });
}

/**
 * Stores synthesized audio as MP3 under `<CLOUDINARY_UPLOAD_FOLDER>/speech/<key>`
 * (Cloudinary files audio under its "video" type) with its cache row; a
 * concurrent duplicate is fine.
 */
async function storeAudio(key: string, voiceId: string, modelId: string, text: string, wav: Buffer, seconds: number) {
  const audio = wavToMp3(wav);
  const upload = await getStorageProvider().uploadBuffer(audio, {
    publicId: storagePath("speech", key),
    resourceType: "video",
    format: "mp3",
    mime: "audio/mpeg",
    isPublic: false,
    tags: ["speech"],
  });
  return db.speechCache.upsert({
    where: { key },
    create: {
      key,
      provider: "natural",
      modelId,
      voiceId,
      chars: text.length,
      seconds,
      storageId: upload.publicId,
      mime: "audio/mpeg",
      bytes: upload.bytes,
    },
    update: { lastUsedAt: new Date() },
  });
}

export interface SegmentAudio {
  url: string;
  seconds: number;
  cached: boolean;
  credits: number;
}

/** Step 2: the audio of one segment (cached, or synthesized and billed now). */
export async function synthesizeReadAloudSegment(
  actor: Actor,
  target: SpeechTarget,
  index: number,
  options: { codeOmitted: string; voiceId?: string; signal?: AbortSignal }
): Promise<SegmentAudio> {
  const [{ markdown, workspaceId }, voice, entitlements] = await Promise.all([
    resolveSpeechText(actor, target),
    resolveVoiceSettings(actor.userId),
    getEntitlements(actor.userId),
  ]);
  if (!entitlements.features.naturalVoices) {
    throw Errors.forbidden("Natural voices aren't included in your plan", "plan_upgrade_required");
  }
  const voiceId = options.voiceId && isNaturalVoice(options.voiceId) ? options.voiceId : (voice.provider === "natural" ? voice.voiceId : null) ?? DEFAULT_NATURAL_VOICE;
  const { segments } = prepareSpeech(markdown, { codeOmitted: options.codeOmitted });
  const text = segments[index];
  if (text === undefined) throw Errors.notFound("Segment");

  const provider = getNaturalSpeechProvider();
  const key = speechCacheKey(text, provider.modelId, voiceId);
  const hit = await db.speechCache.findUnique({ where: { key } });
  if (hit) {
    await db.speechCache.update({ where: { key }, data: { lastUsedAt: new Date() } });
    return { url: await signedUrl(hit.storageId, hit.mime), seconds: hit.seconds, cached: true, credits: 0 };
  }

  // Not cached: check the day's seconds, reserve on the listener's own account.
  const limitSeconds = entitlements.limits.readAloudSecondsPerDay;
  const estimate = estimateAudioSeconds(text.length);
  if ((await countReadAloudSecondsToday(actor.userId)) + estimate > limitSeconds) {
    // A plan without natural voices has limit 0: that's not a limit "hit".
    if (limitSeconds > 0) void recordLimitHit(actor.userId, "READ_ALOUD_CAP");
    throw dailyLimitError();
  }

  let account = await getAccountByUserId(actor.userId);
  if (!account) account = await createAccountWithFreeGrant(actor.userId);
  const generationId = randomUUID();
  // Sized at 1.5× the estimate so a slow reading isn't under-reserved.
  const reserveAmount = speechCreditsFor(Math.ceil(estimate * 1.5), text.length);
  await reserve(account.id, reserveAmount, `res_speech_${generationId}`, {
    generationId,
    actorId: actor.userId,
    estimated: true,
    guard: async (tx) => {
      // Under the account lock, so parallel segments can't all pass the check.
      if ((await countReadAloudSecondsToday(actor.userId, tx)) + estimate > limitSeconds) throw dailyLimitError();
      await tx.generation.create({
        data: {
          id: generationId,
          workspaceId,
          actorId: actor.userId,
          billedAccountId: account!.id,
          kind: "SPEECH",
          status: "RUNNING",
          modelKey: "speech-natural",
          providerModelId: provider.modelId,
          promptVersion: "speech-1",
          idempotencyKey: `speech_${generationId}`,
          reservedCredits: reserveAmount,
          usage: { seconds: estimate, chars: text.length, voiceId },
          startedAt: new Date(),
        },
      });
    },
  });

  try {
    const result = await provider.synthesize({ text, voiceId, signal: options.signal });
    const seconds = Math.round(result.usage.audioSeconds * 10) / 10;
    const cache = await storeAudio(key, voiceId, provider.modelId, text, result.audio, seconds);
    const credits = speechCreditsFor(seconds, text.length);
    await settle(account.id, generationId, credits, `stl_speech_${generationId}`);
    await db.generation.update({
      where: { id: generationId },
      data: {
        status: "COMPLETED",
        chargedCredits: credits,
        usage: { seconds, chars: text.length, voiceId },
        finishedAt: new Date(),
      },
    });
    return { url: await signedUrl(cache.storageId, cache.mime), seconds, cached: false, credits };
  } catch (err) {
    await release(account.id, generationId, `rel_speech_${generationId}`).catch(() => undefined);
    await db.generation
      .update({
        where: { id: generationId },
        data: { status: "FAILED", errorCode: options.signal?.aborted ? "aborted" : "speech_failed", finishedAt: new Date() },
      })
      .catch(() => undefined);
    if (options.signal?.aborted) throw new ApiError(499, "aborted", "Cancelled");
    if (err instanceof SpeechProviderError || !(err instanceof ApiError)) {
      // The player falls back to the browser's voice.
      throw new ApiError(503, "speech_unavailable", "Natural voices are unavailable right now");
    }
    throw err;
  }
}

/**
 * A short sample of a natural voice in the page's language, generated once
 * per voice and sample text and cached; free for everyone (Klecx pays the
 * one-time cost). Only for plans with natural voices.
 */
export async function previewVoice(actor: Actor, voiceId: string, sampleText: string): Promise<{ url: string }> {
  const entitlements = await getEntitlements(actor.userId);
  if (!entitlements.features.naturalVoices) {
    throw Errors.forbidden("Natural voices aren't included in your plan", "plan_upgrade_required");
  }
  if (!isNaturalVoice(voiceId)) throw Errors.notFound("Voice");
  const provider = getNaturalSpeechProvider();
  const key = speechCacheKey(`${PREVIEW_SPEAKER}:${sampleText}`, provider.modelId, voiceId);
  const hit = await db.speechCache.findUnique({ where: { key } });
  if (hit) return { url: await signedUrl(hit.storageId, hit.mime) };
  try {
    const result = await provider.synthesize({ text: sampleText, voiceId });
    const cache = await storeAudio(key, voiceId, provider.modelId, sampleText, result.audio, result.usage.audioSeconds);
    return { url: await signedUrl(cache.storageId, cache.mime) };
  } catch {
    throw new ApiError(503, "speech_unavailable", "Natural voices are unavailable right now");
  }
}

/** What Settings → Voice needs. */
export async function getVoiceOverview(userId: string) {
  const [voice, entitlements] = await Promise.all([resolveVoiceSettings(userId), getEntitlements(userId)]);
  return {
    ...voice,
    voices: NATURAL_VOICES.map((v, i) => ({ id: v.id, number: i + 1, style: v.style })),
    dailyLimitSeconds: entitlements.limits.readAloudSecondsPerDay,
    usedTodaySeconds: Math.round(await countReadAloudSecondsToday(userId)),
  };
}
