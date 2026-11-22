import { route } from "@/server/http/route";
import { segmentSpeechSchema } from "@/lib/schemas/speech";
import { synthesizeReadAloudSegment } from "@/server/services/speech";
import { requestTranslator } from "@/server/i18n/request-translator";

/**
 * Step 9.4: the audio of one segment with a natural voice: a short-lived
 * signed URL. Cached audio is free; otherwise it's synthesized now and billed
 * to the listener. Closing the request (Stop) cancels the synthesis.
 */
export const POST = route({
  body: segmentSpeechSchema,
  rateLimit: { policy: "speech:segment", key: (c) => c.actor.userId },
  handler: async ({ actor, body, req }) => {
    const t = await requestTranslator(req);
    return synthesizeReadAloudSegment(actor, body.target, body.index, {
      codeOmitted: t("Speech.codeOmitted"),
      voiceId: body.voiceId,
      signal: req.signal,
    });
  },
});
