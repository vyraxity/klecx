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
  return cookie;
}

function lhci(args) {
  const res = spawnSync("npx", ["lhci", ...args], { stdio: "inherit", shell: isWin });
  return res.status ?? 1;
}

function runGroup(name, paths, assertions, extraHeaders) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const config = {
    ci: {
      collect: {
        url: paths.map((p) => `${E2E_BASE_URL}${p}`),
        numberOfRuns: 3,
        chromePath: chromePath(),
        settings: {
          chromeFlags: "--headless=new --no-sandbox --disable-dev-shm-usage",
          ...(extraHeaders ? { extraHeaders: JSON.stringify(extraHeaders) } : {}),
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
    failed += runGroup("app", APP_PATHS, APP_ASSERTIONS, { Cookie: cookie }) ? 1 : 0;
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
