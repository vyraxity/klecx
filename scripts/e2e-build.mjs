// Step 10.4: builds Klecx for the end-to-end tests (a production build in test
// mode, `e2e/env.mjs`): migrates the e2e database, then `next build`.
import { spawnSync } from "node:child_process";
import { E2E_ENV } from "../e2e/env.mjs";

const env = { ...process.env, ...E2E_ENV };
for (const [cmd, args] of [
  ["npx", ["prisma", "migrate", "deploy"]],
  ["npx", ["next", "build"]],
]) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
