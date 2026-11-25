/**
 * Step 10.4: the environment of the end-to-end runs (dummy values, never
 * secrets). The app runs as a production build (`next start`) in test mode:
 * fake AI and voice, fake Creem, test inbox, mock storage, its own database.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * `E2E_DATABASE_URL` / `E2E_PORT` may be set in `.env.local` or `.env` (the
 * e2e scripts and Playwright don't load those files themselves). Only the
 * `E2E_*` keys are read; a value already in the environment wins.
 */
for (const file of [".env.local", ".env"]) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(E2E_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/klecx_e2e";
/** Known to the tests too: they sign webhooks only through the app's own simulator. */
export const E2E_WEBHOOK_SECRET = "whsec_e2e_dummy_secret_0000";

/** @type {Record<string, string>} */
export const E2E_ENV = {
  NODE_ENV: "production",
  E2E_TEST_MODE: "true",
  AI_PROVIDER: "fake",
  APP_URL: E2E_BASE_URL,
  DATABASE_URL: E2E_DATABASE_URL,
  BETTER_AUTH_SECRET: "e2e-dummy-auth-secret-min-32-chars-long!",
  GEMINI_API_KEY: "e2e-dummy-key-0000",
  RESEND_API_KEY: "re_e2e_dummy",
  EMAIL_FROM: "Klecx <e2e@example.com>",
  SUPPORT_EMAIL: "support@example.com",
  PRIVACY_EMAIL: "privacy@example.com",
  ABUSE_EMAIL: "abuse@example.com",
  COMPANY_LEGAL_NAME: "Klecx Test",
  COMPANY_ADDRESS: "Test address",
  COMPANY_COUNTRY: "NG",
  PWNED_PASSWORD_CHECK: "false",
  CSP_REPORT_ONLY: "false",
  BILLING_ENABLED: "true",
  BILLING_PROVIDER: "creem",
  CREEM_API_KEY: "creem_test_e2e_dummy",
  CREEM_API_BASE: "https://test-api.creem.io",
  CREEM_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
  CREEM_PRODUCT_LITE_MONTH: "prod_e2e_lite_m",
  CREEM_PRODUCT_LITE_YEAR: "prod_e2e_lite_y",
  CREEM_PRODUCT_STANDARD_MONTH: "prod_e2e_std_m",
  CREEM_PRODUCT_STANDARD_YEAR: "prod_e2e_std_y",
  CREEM_PRODUCT_PRO_MONTH: "prod_e2e_pro_m",
  CREEM_PRODUCT_PRO_YEAR: "prod_e2e_pro_y",
  CRON_SECRET: "e2e-dummy-cron-secret-0000000000000000",
  LOG_LEVEL: "warn",
};
