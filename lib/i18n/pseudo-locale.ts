/**
 * Step 10.5 — pseudo-locale `en-XA` for finding layout problems before a real
 * translation does: every message becomes accented and about 30 % longer,
 * wrapped in brackets, e.g. "Save" → "[Šåvé ··]". Text cut off, overflowing or
 * stitched together from pieces shows at a glance, and any English left
 * unaccented is a string that doesn't go through next-intl.
 *
 * Never offered to people: it's only honoured outside production builds and in
 * the end-to-end test mode (`isPseudoLocaleAllowed()`), by setting the
 * `NEXT_LOCALE` cookie to `en-XA` (dates and numbers stay English).
 *
 * ICU syntax is kept: `{name}` placeholders, `{n, plural, one {…} other {…}}`
 * and select options (their text is transformed), `#`, `<tag>…</tag>`, and
 * apostrophe-quoted text.
 */
export const PSEUDO_LOCALE = "en-XA";

const ACCENTS: Record<string, string> = {
  a: "å", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Å", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

export function isPseudoLocaleAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.E2E_TEST_MODE === "true";
}

/** One ICU message → its pseudo-localized form. */
export function pseudoLocalize(message: string): string {
  const { out, letters } = transform(message, 0, false);
  const pad = Math.max(1, Math.ceil(letters * 0.3));
  return `[${out.text} ${"·".repeat(pad)}]`;
}

/** Every string in a message tree (objects and arrays) pseudo-localized. */
export function pseudoLocalizeMessages<T>(messages: T): T {
  if (typeof messages === "string") return pseudoLocalize(messages) as T;
  if (Array.isArray(messages)) return messages.map((m) => pseudoLocalizeMessages(m)) as T;
  if (messages && typeof messages === "object") {
    return Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, pseudoLocalizeMessages(v)])) as T;
  }
  return messages;
}

interface Piece {
  text: string;
  end: number;
}

/**
 * Transforms text from `start` until the end, or until the `}` that closes a
 * plural/select option when `inOption` (returned `end` is that brace's index).
 */
function transform(src: string, start: number, inOption: boolean): { out: Piece; letters: number } {
  let text = "";
  let letters = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "}" && inOption) return { out: { text, end: i }, letters };
    if (ch === "'") {
      // ICU quoting: '' is an apostrophe; an apostrophe before a syntax
      // character ('{…}') starts quoted text. Elsewhere ("don't") it's just text.
      const next = src[i + 1];
      if (next === "'") {
        text += "''";
        i += 2;
        continue;
      }
      if (next && "{}#<>|".includes(next)) {
        const close = src.indexOf("'", i + 1);
        const quoted = close === -1 ? src.slice(i) : src.slice(i, close + 1);
        text += quoted;
        i += quoted.length;
        continue;
      }
    }
    if (ch === "<") {
      const close = src.indexOf(">", i);
      if (close !== -1 && /^<\/?[A-Za-z][\w-]*\s*\/?>$/.test(src.slice(i, close + 1))) {
        text += src.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (ch === "{") {
      const arg = argument(src, i);
      text += arg.out.text;
      letters += arg.letters;
      i = arg.out.end + 1;
      continue;
    }
    const accented = ACCENTS[ch];
    if (accented) letters++;
    text += accented ?? ch;
    i++;
  }
  return { out: { text, end: i }, letters };
}

/** `{…}` starting at `start`: placeholders kept, plural/select options transformed. */
function argument(src: string, start: number): { out: Piece; letters: number } {
  const header = /^\{\s*([\w.]+)\s*(?:,\s*(\w+)\s*)?(,|\})/.exec(src.slice(start));
  if (!header) return { out: { text: src.slice(start, matching(src, start) + 1), end: matching(src, start) }, letters: 0 };
  const [, , type] = header;
  if (!type || !/^(plural|select|selectordinal)$/.test(type) || header[3] === "}") {
    const end = matching(src, start);
    return { out: { text: src.slice(start, end + 1), end }, letters: 0 };
  }
  // Options: `key {message}` pairs (plural keys may be `=0`, `one`…; `offset:n` is kept).
  let text = src.slice(start, start + header[0].length);
  let i = start + header[0].length;
  let letters = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "}") return { out: { text: text + "}", end: i }, letters };
    if (ch === "{") {
      const inner = transform(src, i + 1, true);
      text += `{${inner.out.text}}`;
      letters = Math.max(letters, inner.letters);
      i = inner.out.end + 1;
      continue;
    }
    text += ch;
    i++;
  }
  return { out: { text, end: i }, letters };
}

function matching(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i;
  }
  return src.length - 1;
}
