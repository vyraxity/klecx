import "server-only";
import { env } from "@/server/env";
import { getGeminiClient } from "@/server/ai/providers/gemini";
import { NATURAL_VOICES, isNaturalVoice } from "@/lib/speech/voices";
import { SpeechProviderError, type SpeechProvider, type SynthesizeInput, type SynthesizeResult } from "./provider";
import { isWav, pcmToWav, wavDurationSeconds } from "./wav";

/**
 * Step 9.4: natural voices through the provider's text-to-speech model
 * (`GEMINI_TTS_MODEL`, default the "flash-lite" TTS model, which the
 * provider's docs recommend for read-aloud). Called through the same
 * `generateContent` API as answers, with audio output and a prebuilt voice.
 * The output is a WAV file (newer models) or raw 24 kHz PCM, which is wrapped.
 */
export class GeminiSpeechProvider implements SpeechProvider {
  public readonly id = "natural" as const;
  public readonly modelId = env.GEMINI_TTS_MODEL;

  listVoices() {
    return NATURAL_VOICES.map((v) => ({ id: v.id, style: v.style }));
  }

  async synthesize({ text, voiceId, signal }: SynthesizeInput): Promise<SynthesizeResult> {
    if (!isNaturalVoice(voiceId)) {
      throw new SpeechProviderError(`Unknown voice ${voiceId}`, false);
    }
    let response;
    try {
      response = await getGeminiClient().models.generateContent({
        model: this.modelId,
        contents: [{ role: "user", parts: [{ text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } },
          abortSignal: signal,
        },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const status = (err as { status?: number })?.status;
      throw new SpeechProviderError(
        `Text-to-speech request failed${status ? ` (${status})` : ""}`,
        status === undefined || status >= 500 || status === 429
      );
    }

    const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const data = part?.inlineData?.data;
    if (!data) throw new SpeechProviderError("No audio in the response", true);
    const raw = Buffer.from(data, "base64");
    const audio = isWav(raw) ? raw : pcmToWav(raw, sampleRateOf(part?.inlineData?.mimeType));
    return {
      audio,
      mime: "audio/wav",
      usage: { chars: text.length, audioSeconds: wavDurationSeconds(audio) },
    };
  }
}

/** "audio/L16;codec=pcm;rate=24000" → 24000. */
function sampleRateOf(mime: string | undefined): number {
  const m = mime?.match(/rate=(\d+)/i);
  return m ? Number(m[1]) : 24_000;
}

let provider: SpeechProvider | null = null;

/**
 * Step 10.4: `AI_PROVIDER=fake` (never in production) — a short tone per
 * part, no network: end-to-end and load tests can play natural voices.
 */
export class FakeSpeechProvider implements SpeechProvider {
  public readonly id = "natural" as const;
  public readonly modelId = "fake-tts";

  listVoices() {
    return NATURAL_VOICES.map((v) => ({ id: v.id, style: v.style }));
  }

  async synthesize({ text, voiceId }: SynthesizeInput): Promise<SynthesizeResult> {
    if (!isNaturalVoice(voiceId)) throw new SpeechProviderError(`Unknown voice ${voiceId}`, false);
    // ~0.06 s per character, between 0.5 s and 10 s, of a quiet 440 Hz tone at 24 kHz.
    const seconds = Math.min(10, Math.max(0.5, text.length * 0.06));
    const rate = 24_000;
    const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
    for (let i = 0; i < pcm.length / 2; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), i * 2);
    }
    const audio = pcmToWav(pcm, rate);
    return { audio, mime: "audio/wav", usage: { chars: text.length, audioSeconds: wavDurationSeconds(audio) } };
  }
}

/** The natural-voice provider (tests can swap it). */
export function getNaturalSpeechProvider(): SpeechProvider {
  provider ??= env.AI_PROVIDER === "fake" ? new FakeSpeechProvider() : new GeminiSpeechProvider();
  return provider;
}

export function setNaturalSpeechProviderForTesting(p: SpeechProvider | null) {
  provider = p;
}
