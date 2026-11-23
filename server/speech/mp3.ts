import "server-only";
import { Mp3Encoder } from "@breezystack/lamejs";

/**
 * Step 9.4: stored read-aloud audio is MP3, not WAV (owner, 2026-11-23).
 * Speech at 24 kHz mono needs little bitrate: 48 kbps is about 0.36 MB per
 * minute instead of 2.9 MB for the WAV the provider returns.
 */
export const SPEECH_MP3_KBPS = 48;
const FRAME_SAMPLES = 1152;

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

function readWav(wav: Buffer): WavInfo {
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      bitsPerSample = wav.readUInt16LE(offset + 22);
    }
    if (id === "data") {
      const end = Math.min(offset + 8 + size, wav.length);
      return { sampleRate, channels, bitsPerSample, data: wav.subarray(offset + 8, end) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV without a data chunk");
}

/** Encodes a 16-bit PCM WAV (mono or stereo) as MP3. */
export function wavToMp3(wav: Buffer, kbps = SPEECH_MP3_KBPS): Buffer {
  const { sampleRate, channels, bitsPerSample, data } = readWav(wav);
  if (bitsPerSample !== 16 || (channels !== 1 && channels !== 2) || !sampleRate) {
    throw new Error("Unsupported WAV format");
  }
  // Copy into an aligned Int16Array (the data chunk's offset may be odd).
  const samples = new Int16Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);

  let left = samples;
  let right: Int16Array | undefined;
  if (channels === 2) {
    const frames = Math.floor(samples.length / 2);
    left = new Int16Array(frames);
    right = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = samples[i * 2]!;
      right[i] = samples[i * 2 + 1]!;
    }
  }

  const encoder = new Mp3Encoder(channels, sampleRate, kbps);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += FRAME_SAMPLES) {
    const out = encoder.encodeBuffer(
      left.subarray(i, i + FRAME_SAMPLES),
      right?.subarray(i, i + FRAME_SAMPLES)
    );
    if (out.length) chunks.push(out);
  }
  const end = encoder.flush();
  if (end.length) chunks.push(end);
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
}
