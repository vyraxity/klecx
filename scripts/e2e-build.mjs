// Step 10.4: builds Klecx for the end-to-end tests (a production build in test
// mode, `e2e/env.mjs`): creates the e2e database if it doesn't exist, applies
// the migrations, then `next build`. Works on Windows, macOS and Linux.
import { spawnSync } from "node:child_process";
import pg from "pg";
import { E2E_DATABASE_URL, E2E_ENV } from "../e2e/env.mjs";

const env = { ...process.env, ...E2E_ENV };
// On Windows `npx` is a .cmd script, which Node only starts through a shell.
const shell = process.platform === "win32";

async function ensureDatabase(url) {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.end();
    console.log(`[e2e] Database "${name}" is ready.`);
    return;
  } catch (err) {
    await client.end().catch(() => {});
    if (err?.code !== "3D000") {
      console.error(`[e2e] Can't connect to ${target.host} (${err?.code ?? ""} ${err?.message ?? err}).`);
      console.error("[e2e] Is Postgres running, and is E2E_DATABASE_URL right? (.env / .env.local or the environment)");
      process.exit(1);
    }
  }
  // 3D000: the server is there but the database isn't: create it.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client2 = new pg.Client({ connectionString: admin.toString() });
  await client2.connect();
  await client2.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  await client2.end();
  console.log(`[e2e] Created database "${name}".`);
}

function run(cmd, args) {
  console.log(`[e2e] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell });
  if (r.error) {
    console.error(`[e2e] Could not start ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[e2e] ${cmd} ${args.join(" ")} failed (exit code ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

await ensureDatabase(E2E_DATABASE_URL);
run("npx", ["prisma", "migrate", "deploy"]);
run("npx", ["prisma", "generate"]);
run("npx", ["next", "build"]);
console.log("[e2e] Build ready. Run the journeys with: npm run e2e");
