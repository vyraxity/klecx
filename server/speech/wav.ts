import "server-only";

/** Step 9.4: WAV helpers for the text-to-speech output (24 kHz mono 16-bit PCM). */
export const TTS_SAMPLE_RATE = 24_000;

/** Wraps raw little-endian 16-bit PCM in a RIFF/WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = TTS_SAMPLE_RATE, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function isWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

/** Duration of a WAV file in seconds (reads the fmt and data chunks). */
export function wavDurationSeconds(wav: Buffer): number {
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = wav.readUInt32LE(offset + 16);
    if (id === "data" && byteRate > 0) {
      const dataSize = Math.min(size, wav.length - offset - 8);
      return dataSize / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return 0;
}
