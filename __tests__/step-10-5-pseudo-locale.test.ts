/**
 * @jest-environment node
 */
import IntlMessageFormat from "intl-messageformat";
import en from "@/messages/en.json";
import { isPseudoLocaleAllowed, pseudoLocalize, pseudoLocalizeMessages } from "@/lib/i18n/pseudo-locale";

/** Step 10.5: the pseudo-locale keeps ICU syntax and makes text longer. */
function strings(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((n, i) => strings(n, `${path}.${i}`));
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe("Step 10.5 — pseudo-locale en-XA", () => {
  it("accents text, pads it about 30 % and brackets it", () => {
    const out = pseudoLocalize("Save changes");
    expect(out).toMatch(/^\[Šåṽé çĥåñĝéš ·+\]$/);
    expect(out.length).toBeGreaterThan("Save changes".length * 1.3);
  });

  it("keeps placeholders, plurals, selects, # and tags", () => {
    expect(pseudoLocalize("Hello {name}")).toContain("{name}");
    const plural = pseudoLocalize("{count, plural, one {# credit} other {# credits}} left");
    expect(plural).toContain("{count, plural, one {# çŕéðîţ} other {# çŕéðîţš}}");
    expect(pseudoLocalize("{kind, select, a {Alpha} other {Other}}")).toContain("a {Åļþĥå}");
    expect(pseudoLocalize("Read the <link>terms</link>")).toContain("<link>ţéŕɱš</link>");
    expect(pseudoLocalize("Price: {price, number, ::currency/USD}")).toContain("{price, number, ::currency/USD}");
    expect(pseudoLocalize("It''s {n}")).toContain("''");
    // An apostrophe inside a word isn't ICU quoting: the rest is still transformed.
    expect(pseudoLocalize("We don't sell")).toContain("ðöñ'ţ šéļļ");
    expect(pseudoLocalize("Use '{braces}' literally")).toContain("'{braces}'");
  });

  it("every English message still formats after the transformation", () => {
    const pseudo = pseudoLocalizeMessages(en);
    const broken: string[] = [];
    for (const [key, message] of strings(pseudo)) {
      try {
        new IntlMessageFormat(message, "en", undefined, { ignoreTag: false }).getAst();
      } catch (err) {
        broken.push(`${key}: ${(err as Error).message}`);
      }
    }
    expect(broken).toEqual([]);
    // Same arguments as English, read from the parsed messages.
    type Node = { type: number; value?: string; options?: Record<string, { value: Node[] }>; children?: Node[] };
    const args = (message: string) => {
      const found: string[] = [];
      const walk = (nodes: Node[]) => {
        for (const n of nodes) {
          if (n.type !== 0 && n.type !== 7 && n.value) found.push(n.value); // 0 literal, 7 pound
          if (n.options) for (const o of Object.values(n.options)) walk(o.value);
          if (n.children) walk(n.children);
        }
      };
      walk(new IntlMessageFormat(message, "en").getAst() as unknown as Node[]);
      return found.sort();
    };
    const enStrings = new Map(strings(en));
    for (const [key, message] of strings(pseudo)) {
      expect([key, args(message)]).toEqual([key, args(enStrings.get(key)!)]);
    }
  });

  it("is never available in a production build outside the e2e test mode", () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { NODE_ENV: env.NODE_ENV, E2E_TEST_MODE: env.E2E_TEST_MODE };
    try {
      env.NODE_ENV = "production";
      delete env.E2E_TEST_MODE;
      expect(isPseudoLocaleAllowed()).toBe(false);
      env.E2E_TEST_MODE = "true";
      expect(isPseudoLocaleAllowed()).toBe(true);
      env.NODE_ENV = "development";
      delete env.E2E_TEST_MODE;
      expect(isPseudoLocaleAllowed()).toBe(true);
    } finally {
      env.NODE_ENV = saved.NODE_ENV;
      if (saved.E2E_TEST_MODE === undefined) delete env.E2E_TEST_MODE;
      else env.E2E_TEST_MODE = saved.E2E_TEST_MODE;
    }
  });
});
