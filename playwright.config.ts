import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_ENV, E2E_PORT } from "./e2e/env.mjs";

/**
 * Step 10.4 — end-to-end journeys (`e2e/*.e2e.ts`). Runs a production build
 * of Klecx in test mode (`e2e/env.ts`): `npm run e2e:build` once, then
 * `npm run e2e`. CI: `.github/workflows/e2e.yml` (nightly, PRs to main, by hand).
 *
 * In a Claude Code cloud container, set PW_CHROMIUM_PATH=/opt/pw-browsers/chromium
 * to use the preinstalled browser (Chromium only there).
 */
const chromiumPath = process.env.PW_CHROMIUM_PATH;
const launchOptions = chromiumPath ? { executablePath: chromiumPath } : {};

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  // Journeys share one app and one database; each uses its own fresh people.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 1,
  // Flake policy (docs/testing.md): a retry that passes is still reported as flaky.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: "./e2e/global-setup.ts",
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }], ["github"]] : [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions } },
    // WebKit needs its own browser (CI installs it; the cloud container has Chromium only).
    ...(chromiumPath ? [] : [{ name: "webkit", use: { ...devices["Desktop Safari"] } }]),
    // Phone layout: the core journeys only (tagged @mobile).
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions }, grep: /@mobile/ },
  ],
  webServer: {
    command: `npx next start -p ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    env: E2E_ENV,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
