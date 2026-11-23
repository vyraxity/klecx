import "server-only";

/**
 * Step 9.4: a text-to-speech provider. "natural" is the AI model on the
 * server; "browser" voices are spoken by the browser itself (no server call,
 * no credits) and never reach this interface. Another provider later only
 * has to implement this and list its voices; nothing else changes.
 */
export interface SpeechVoice {
  id: string;
  style: string;
}

export interface SynthesizeInput {
  text: string;
  voiceId: string;
  signal?: AbortSignal;
}

export interface SynthesizeResult {
  /** A complete WAV file. */
  audio: Buffer;
  mime: "audio/wav";
  usage: { chars: number; audioSeconds: number };
}

export interface SpeechProvider {
  id: "natural";
  /** The provider's model id (stored with cached audio; part of the cache key). */
  modelId: string;
  listVoices(): SpeechVoice[];
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
}

export class SpeechProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "SpeechProviderError";
  }
}
