/**
 * @jest-environment node
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Step 10.5: check:i18n fails on message keys no code uses (heuristic: the
 * namespace and the key, or a parent, or a template prefix, appear as strings).
 */
const ROOT = process.cwd();

function runCheck(source: string, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-unused-"));
  try {
    const messages = {
      Demo: { title: "Title", unusedOne: "Nobody reads this", providers: { browser: "Device", natural: "Natural" }, sections: [{ heading: "A" }] },
      Spare: { lonely: "Never used" },
    };
    fs.mkdirSync(path.join(dir, "messages"));
    for (const loc of ["en", "es", "fr"]) fs.writeFileSync(path.join(dir, "messages", `${loc}.json`), JSON.stringify(messages));
    fs.mkdirSync(path.join(dir, "i18n"));
    fs.copyFileSync(path.join(ROOT, "i18n", "locales.ts"), path.join(dir, "i18n", "locales.ts"));
    fs.mkdirSync(path.join(dir, "components"));
    fs.writeFileSync(path.join(dir, "components", "demo.tsx"), source);
    return spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-i18n.mjs")], {
      cwd: ROOT,
      env: { ...process.env, I18N_CHECK_ROOT: dir, ...env },
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SOURCE = `
const t = useTranslations("Demo");
t("title");
t(\`providers.\${p}\`);
t.raw("sections");
`;

describe("Step 10.5 — unused message keys", () => {
  it("fails on keys nothing uses, and accepts direct, dynamic and whole-array uses", () => {
    const res = runCheck(SOURCE);
    const out = res.stdout + res.stderr;
    expect(res.status).toBe(1);
    expect(out).toContain("Unused key in 'en': Demo.unusedOne");
    expect(out).toContain("Unused key in 'en': Spare.lonely");
    expect(out).not.toContain("Demo.title");
    expect(out).not.toContain("Demo.providers");
    expect(out).not.toContain("Demo.sections");
  });

  it("only warns with I18N_UNUSED=warn", () => {
    const res = runCheck(SOURCE, { I18N_UNUSED: "warn" });
    expect(res.status).toBe(0);
    expect(res.stdout + res.stderr).toContain("2 message keys look unused");
  });
});
