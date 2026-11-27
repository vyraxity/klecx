// Step 10.5 — Lighthouse against the test-mode build (`npm run e2e:build`).
//
//   npm run lighthouse
//
// Marketing pages must score ≥ 90 performance, ≥ 95 accessibility and ≥ 95
// SEO; signed-in app pages ≥ 95 accessibility (median of 3 runs each). Starts
// the build on E2E_PORT unless one already answers there, signs a test person
// up through the test inbox for the app pages, and writes the HTML reports to
// `.lighthouseci/reports/`. Exits non-zero when a page is below its target.
//
// Chrome: CHROME_PATH, else PW_CHROMIUM_PATH, else Playwright's Chromium.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_ENV, E2E_PORT } from "../e2e/env.mjs";

export const MARKETING_PATHS = ["/", "/pricing", "/features", "/help"];
/** Sign-in is `noindex` on purpose, so it isn't held to the SEO target. */
export const SIGN_IN_PATHS = ["/auth/login"];
export const APP_PATHS = ["/workspaces", "/settings/profile", "/settings/usage"];

export const MARKETING_ASSERTIONS = {
  "categories:performance": ["error", { minScore: 0.9, aggregationMethod: "median-run" }],
  "categories:accessibility": ["error", { minScore: 0.95, aggregationMethod: "median-run" }],
  "categories:seo": ["error", { minScore: 0.95, aggregationMethod: "median-run" }],
};
export const SIGN_IN_ASSERTIONS = {
  "categories:performance": MARKETING_ASSERTIONS["categories:performance"],
  "categories:accessibility": MARKETING_ASSERTIONS["categories:accessibility"],
};
export const APP_ASSERTIONS = {
  "categories:accessibility": ["error", { minScore: 0.95, aggregationMethod: "median-run" }],
};

const OUT = path.resolve(".lighthouseci");
const isWin = process.platform === "win32";
const log = (msg) => console.log(`[lighthouse] ${msg}`);

/**
 * The app pages need a test account, saved in the e2e database: check it's
 * there before spending minutes on the other pages. Returns an explanation
 * when it isn't, null when it is.
 */
export async function databaseProblem(url = E2E_DATABASE_URL) {
  let where = "the e2e database";
  try {
    const u = new URL(url);
    where = `"${decodeURIComponent(u.pathname.replace(/^\//, ""))}" on ${u.host}`;
  } catch {
    return "E2E_DATABASE_URL isn't a valid postgresql:// address (.env / .env.local or the environment).";
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('select 1 from "users" limit 1');
    return null;
  } catch (err) {
    const code = err?.code ?? "";
    if (code === "3D000") return `The database ${where} doesn't exist yet: run \`npm run e2e:build\` (it creates it and applies the migrations).`;
    if (code === "42P01") return `The database ${where} has no tables: run \`npm run e2e:build\` (it applies the migrations).`;
    if (code === "28P01" || code === "28000") return `Postgres refused the user or password for ${where}: check E2E_DATABASE_URL (.env / .env.local).`;
    return `Can't reach ${where} (${code || err?.message || err}). Is Postgres running (start Docker if it runs there), and is E2E_DATABASE_URL right (.env / .env.local)?`;
  } finally {
    await client.end().catch(() => {});
  }
}

async function up() {
  try {
    return (await fetch(`${E2E_BASE_URL}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await up()) return null;
  log(`starting the test build on port ${E2E_PORT}…`);
  const child = spawn("npx", ["next", "start", "-p", String(E2E_PORT)], {
    env: { ...process.env, ...E2E_ENV },
    stdio: "ignore",
    shell: isWin,
  });
  for (let i = 0; i < 120; i++) {
    if (await up()) return child;
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error("the test build didn't start (run `npm run e2e:build` first)");
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  const out = spawnSync(process.execPath, ["-e", "console.log(require('@playwright/test').chromium.executablePath())"], { encoding: "utf8" });
  return out.stdout.trim();
}

/** Signs a fresh person up and verifies them through the test inbox; returns their session cookie. */
async function signedInCookie() {
  const email = `lighthouse-${Date.now()}@example.com`;
  const headers = { "content-type": "application/json", origin: E2E_BASE_URL };
  const signUp = await fetch(`${E2E_BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: "A-long-lighthouse-passphrase-42", name: "Lighthouse Tester", callbackURL: "/workspaces" }),
  });
  if (!signUp.ok) {
    throw new Error(
      `signing the test person up failed (HTTP ${signUp.status}). ` +
        (signUp.status >= 500 ? "Check the database (is Postgres running?) and rebuild with `npm run e2e:build`." : (await signUp.text()).slice(0, 200))
    );
  }
  let link;
  for (let i = 0; i < 30 && !link; i++) {
    const res = await fetch(`${E2E_BASE_URL}/api/test/emails?to=${encodeURIComponent(email)}`);
    const mails = (await res.json()).data?.emails ?? [];
    link = mails.find((m) => m.template === "verify-email")?.links?.find((l) => l.includes("/verify-email"));
    if (!link) await new Promise((r) => setTimeout(r, 500));
  }
  if (!link) throw new Error("no verification email in the test inbox");
  const verify = await fetch(link, { redirect: "manual" });
  const cookies = verify.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("verification didn't sign the person in");
  // Claim a username, as everyone does on their first visit: otherwise the
  // "Choose your username" dialog opens over the pages, hides them from
  // assistive technology (correctly, it's modal) and Lighthouse scores the
  // dialog instead of the page, more or less depending on timing.
  const claim = await fetch(`${E2E_BASE_URL}/api/v1/me/username`, {
    method: "PUT",
    headers: { ...headers, cookie },
    body: JSON.stringify({ username: `lighthouse_${Date.now().toString(36)}` }),
  });
  if (!claim.ok) throw new Error(`claiming the test person's username failed (HTTP ${claim.status})`);
  return cookie;
}

function lhci(args) {
  const res = spawnSync("npx", ["lhci", ...args], { stdio: "inherit", shell: isWin });
  return res.status ?? 1;
}

/**
 * After a failed assertion: for each page and checked category below 100,
 * the audits that failed, with up to 3 of the elements involved, read from
 * the representative run's report. So the log says what to fix.
 */
export function failedAudits(manifestPath, categories) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const lines = [];
  for (const run of manifest.filter((r) => r.isRepresentativeRun)) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(run.jsonPath, "utf8"));
    } catch {
      continue;
    }
    const page = new URL(run.url).pathname;
    for (const id of categories) {
      const category = report.categories?.[id];
      if (!category || category.score === 1) continue;
      for (const ref of category.auditRefs.filter((r) => r.weight > 0)) {
        const audit = report.audits[ref.id];
        if (!audit || audit.score === null || audit.score >= 0.9) continue;
        const items = audit.details?.items ?? [];
        const nodes = items
          .map((item) => item.node?.snippet ?? item.node?.selector ?? item.url)
          .filter(Boolean)
          .slice(0, 3)
          .map((n) => String(n).replace(/\s+/g, " ").slice(0, 140));
        lines.push(`${page} · ${id} · ${audit.id}: ${audit.title}${audit.displayValue ? ` (${audit.displayValue})` : ""}`);
        for (const n of nodes) lines.push(`      ${n}`);
        if (items.length > nodes.length) lines.push(`      … and ${items.length - nodes.length} more`);
      }
    }
  }
  return lines;
}

/**
 * Signed-in pages: LHCI opens the browser through Puppeteer (puppeteer-core
 * comes with Lighthouse) and runs this before each page, putting the session
 * into the browser's own cookie store. Sending it as an extra `Cookie` header
 * doesn't work: as soon as the page stores any cookie of its own (theme,
 * language…), Chrome sends its cookie store instead of that header, the
 * session is gone and the page bounces to sign-in, more or less often
 * depending on timing.
 */
function writeSignInScript(cookie) {
  const file = path.join(OUT, "sign-in-session.cjs");
  const cookies = cookie.split("; ").map((pair) => {
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i), value: pair.slice(i + 1), url: E2E_BASE_URL, httpOnly: true, sameSite: "Lax" };
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    file,
    `// Written by scripts/lighthouse.mjs for one run (a throw-away test account).\n` +
      `module.exports = async (browser) => {\n` +
      `  const page = await browser.newPage();\n` +
      `  await page.setCookie(...${JSON.stringify(cookies)});\n` +
      `  await page.close();\n` +
      `};\n`
  );
  // LHCI resolves the script against the working directory.
  return path.relative(process.cwd(), file);
}

/** Pages of a group whose run ended somewhere else (e.g. bounced to /auth/login). */
export function signedOutPages(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest
      .filter((run) => {
        const report = JSON.parse(fs.readFileSync(run.jsonPath, "utf8"));
        return new URL(report.finalDisplayedUrl).pathname.startsWith("/auth/");
      })
      .map((run) => new URL(run.url).pathname)
      .filter((p, i, all) => all.indexOf(p) === i);
  } catch {
    return [];
  }
}

function runGroup(name, paths, assertions, sessionCookie) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  // No stale reports: the explanations below read them.
  fs.rmSync(path.join(OUT, "reports", name), { recursive: true, force: true });
  const chrome = chromePath();
  const flags = ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"];
  const config = {
    ci: {
      collect: {
        url: paths.map((p) => `${E2E_BASE_URL}${p}`),
        numberOfRuns: 3,
        chromePath: chrome,
        ...(sessionCookie
          ? {
              puppeteerScript: writeSignInScript(sessionCookie),
              puppeteerLaunchOptions: { executablePath: chrome, headless: true, args: flags.slice(1) },
            }
          : {}),
        settings: {
          // With the login script, Puppeteer starts Chrome (flags in puppeteerLaunchOptions).
          ...(sessionCookie ? {} : { chromeFlags: flags.join(" ") }),
          // Keep the session cookie between runs (Lighthouse clears the site's storage by default).
          ...(sessionCookie ? { disableStorageReset: true } : {}),
          // Desktop: the app's main audience; the phone layout is covered by the e2e journeys.
          preset: "desktop",
        },
        outputDir: dir,
      },
      assert: { assertions, outputDir: dir },
      upload: { target: "filesystem", outputDir: path.join(OUT, "reports", name) },
    },
  };
  const file = path.join(OUT, `${name}.json`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  log(`${name}: ${paths.join(", ")}`);
  let status = lhci(["collect", `--config=${file}`]);
  if (status === 0) lhci(["upload", `--config=${file}`]);
  if (status === 0) status = lhci(["assert", `--config=${file}`]);
  if (status !== 0) {
    const categories = Object.keys(assertions).map((k) => k.replace(/^categories:/, ""));
    const lines = failedAudits(path.join(OUT, "reports", name, "manifest.json"), categories);
    if (lines.length) {
      log(`${name}: what lowered the scores (median run):`);
      for (const l of lines) console.log(`  ${l}`);
    }
  }
  return status;
}

async function main() {
  const problem = await databaseProblem();
  if (problem) {
    log(problem);
    process.exit(1);
  }
  const server = await startServer();
  let failed = 0;
  try {
    // A first visit (no cookies): what search engines and new visitors get.
    failed += runGroup("marketing", MARKETING_PATHS, MARKETING_ASSERTIONS) ? 1 : 0;
    failed += runGroup("sign-in", SIGN_IN_PATHS, SIGN_IN_ASSERTIONS) ? 1 : 0;
    const cookie = await signedInCookie();
    failed += runGroup("app", APP_PATHS, APP_ASSERTIONS, cookie) ? 1 : 0;
    // A signed-in page that bounced to sign-in would be scored as the sign-in page.
    const bounced = signedOutPages(path.join(OUT, "reports", "app", "manifest.json"));
    if (bounced.length) {
      log(`app: these pages ended on sign-in, so their scores are the sign-in page's: ${bounced.join(", ")}`);
      failed += 1;
    }
  } finally {
    server?.kill();
  }
  log(failed ? "below target: see the assertions above and .lighthouseci/reports/" : "all pages meet their targets");
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("lighthouse.mjs")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
