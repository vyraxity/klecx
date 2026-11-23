import { route } from "@/server/http/route";
import { prepareSpeechSchema } from "@/lib/schemas/speech";
import { prepareReadAloud } from "@/server/services/speech";
import { requestTranslator } from "@/server/i18n/request-translator";

/**
 * Step 9.4: prepares a read-aloud: the text of the target (read with the
 * viewer's permissions; 404 without access), split into segments, and the
 * voice to use. Costs nothing; the audio comes per segment.
 */
export const POST = route({
  body: prepareSpeechSchema,
  rateLimit: { policy: "speech:prepare", key: (c) => c.actor.userId },
  handler: async ({ actor, body, req }) => {
    const t = await requestTranslator(req);
    return prepareReadAloud(actor, body.target, { codeOmitted: t("Speech.codeOmitted"), voiceId: body.voiceId });
  },
});
