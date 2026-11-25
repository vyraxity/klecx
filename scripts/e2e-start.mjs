// Step 10.4: starts the test-mode build (`npm run e2e:build`) on E2E_PORT
// (3100) with the end-to-end environment (`e2e/env.mjs`). Used by the load
// test and for exploring the app by hand; Playwright starts it by itself.
import { spawn } from "node:child_process";
import { E2E_ENV, E2E_PORT } from "../e2e/env.mjs";

const child = spawn("npx", ["next", "start", "-p", String(E2E_PORT)], {
  env: { ...process.env, ...E2E_ENV },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
