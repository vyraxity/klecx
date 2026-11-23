/**
 * Step 9.4: turns Markdown into text to read aloud, then splits it into
 * segments of at most MAX_SEGMENT_CHARS at sentence boundaries.
 *
 * - Code blocks become one short spoken placeholder ("Code block omitted").
 * - Links read as their text; bare URLs, images, HTML and citation markers
 *   ([1], [^1]) are dropped.
 * - Table rows read as sentences ("Name, Price, Notes."); separator rows drop.
 * - Headings and list items end with a full stop, so they're read as phrases.
 *
 * Runs on the server (what is synthesized, from text read from the
 * database) and is isomorphic so tests can cover it directly.
 */
export const MAX_SEGMENT_CHARS = 1500;
/** At most this much text per read-aloud request (the rest isn't read). */
export const MAX_SPEECH_CHARS = 20_000;

export interface PrepareOptions {
  /** Spoken in place of a code block, in the page's language. */
  codeOmitted: string;
}

function endSentence(line: string): string {
  const t = line.trim();
  if (!t) return "";
  return /[.!?…:;。！？]$/.test(t) ? t : `${t}.`;
}

export function markdownToSpeech(markdown: string, options: PrepareOptions): string {
  const placeholder = endSentence(options.codeOmitted);
  let text = markdown.replace(/\r\n?/g, "\n");

  // Fenced code blocks (``` or ~~~), then indented blocks of 4+ spaces after a blank line.
  text = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|$(?![\s\S]))/gm, `\n${placeholder}\n`);
  text = text.replace(/<pre[\s\S]*?<\/pre>/gi, `\n${placeholder}\n`);

  const lines = text.split("\n").map((raw) => {
    let line = raw;
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) return ""; // table separator
    if (/^\s*([-*_]\s*){3,}$/.test(line)) return ""; // horizontal rule
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    if (isTableRow) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(", ");
    }
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, "") // headings
      .replace(/^\s*>+\s?/, "") // quotes
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""); // list markers, task boxes
    const isBlockLine = isTableRow || raw !== line || /^\s{0,3}#/.test(raw);
    return isBlockLine ? endSentence(line) : line;
  });
  text = lines.join("\n");

  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\s*\[\^[^\]]+\]/g, "") // footnote markers (with the space before them)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/\s*\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g, "") // citation markers [1], [1, 2]
    .replace(/\s*【[^】]*】/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ") // HTML tags
    .replace(/https?:\/\/\S+/g, "") // bare URLs
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(^|[\s(])([*_])(\S(?:.*?\S)?)\2(?=[\s).,!?:;]|$)/gm, "$1$3") // italics
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1"); // escapes

  // Paragraphs: blank lines separate them; single newlines join with a space.
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function splitSentences(paragraph: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    const seg = new Segmenter(undefined, { granularity: "sentence" });
    return Array.from(seg.segment(paragraph), (s) => s.segment).filter((s) => s.trim());
  }
  return paragraph.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [paragraph];
}

/** Splits a too-long sentence at word boundaries. */
function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of sentence.split(/(\s+)/)) {
    if ((current + word).length > max && current.trim()) {
      out.push(current.trim());
      current = word.trimStart();
    } else {
      current += word;
    }
    while (current.length > max) {
      out.push(current.slice(0, max));
      current = current.slice(max);
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Segments of at most `max` characters, cut at sentence (then word) boundaries. */
export function chunkSpeech(text: string, max = MAX_SEGMENT_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const sentence of splitSentences(paragraph)) {
      const pieces = sentence.length > max ? splitLong(sentence, max) : [sentence];
      for (const piece of pieces) {
        if ((current ? current.length + 1 : 0) + piece.trim().length > max) push();
        current = current ? `${current} ${piece.trim()}` : piece.trim();
      }
    }
    // Keep paragraphs together when they fit; a paragraph break is a pause.
    if (current) current += "\n\n";
  }
  push();
  return chunks.map((c) => c.replace(/\s*\n\n\s*/g, "\n\n").trim()).filter(Boolean);
}

/** The text to read and its segments, capped at MAX_SPEECH_CHARS. */
export function prepareSpeech(
  markdown: string,
  options: PrepareOptions
): { segments: string[]; truncated: boolean; chars: number } {
  const full = markdownToSpeech(markdown, options);
  let text = full;
  let truncated = false;
  if (text.length > MAX_SPEECH_CHARS) {
    truncated = true;
    const cut = text.slice(0, MAX_SPEECH_CHARS);
    // End on the last sentence end inside the cap when there is one.
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n\n"));
    text = lastStop > MAX_SPEECH_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut;
  }
  const segments = chunkSpeech(text);
  return { segments, truncated, chars: segments.reduce((a, s) => a + s.length, 0) };
}
