import { route } from "@/server/http/route";
import { previewSpeechSchema } from "@/lib/schemas/speech";
import { previewVoice } from "@/server/services/speech";
import { requestTranslator } from "@/server/i18n/request-translator";

/** Step 9.4: a short sample of a natural voice, in the page's language (cached; free). */
export const POST = route({
  body: previewSpeechSchema,
  rateLimit: { policy: "speech:preview", key: (c) => c.actor.userId },
  handler: async ({ actor, body, req }) => {
    const t = await requestTranslator(req);
    return previewVoice(actor, body.voiceId, t("Speech.previewSample"));
  },
});
