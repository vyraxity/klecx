import { z } from "zod";
import { VOICE_PROVIDERS, MAX_VOICE_SPEED, MIN_VOICE_SPEED } from "@/lib/speech/voices";

/**
 * Step 9.4: what to read aloud. Every readable surface (rule 8): main
 * responses and uploaded documents (a response version, original or saved
 * edit), Ask answers at any depth (a thread message) and generated documents
 * (a revision).
 */
export const speechTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("RESPONSE_VERSION"),
    id: z.string().min(1).max(100),
    source: z.enum(["ORIGINAL", "EDIT"]).default("ORIGINAL"),
    editRevision: z.number().int().min(1).optional(),
  }),
  z.object({ type: z.literal("ANNOTATION_MESSAGE"), id: z.string().min(1).max(100) }),
  z.object({
    type: z.literal("DOCUMENT_REVISION"),
    id: z.string().min(1).max(100),
    revision: z.number().int().min(1).optional(),
  }),
]);
export type SpeechTarget = z.infer<typeof speechTargetSchema>;

const voiceIdSchema = z.string().trim().min(1).max(200);

export const prepareSpeechSchema = z.object({
  target: speechTargetSchema,
  voiceId: voiceIdSchema.optional(),
});

export const segmentSpeechSchema = z.object({
  target: speechTargetSchema,
  index: z.number().int().min(0).max(100),
  voiceId: voiceIdSchema.optional(),
});

export const previewSpeechSchema = z.object({
  voiceId: voiceIdSchema,
});

/** Voice preferences (`PATCH /api/v1/me/preferences`): checked against the plan on the server. */
export const voicePreferencesSchema = z.object({
  voiceProvider: z.enum(VOICE_PROVIDERS).nullable().optional(),
  /** A natural voice id, or a browser voice name (device-specific). */
  voiceId: voiceIdSchema.nullable().optional(),
  voiceSpeed: z.number().min(MIN_VOICE_SPEED).max(MAX_VOICE_SPEED).optional(),
});
