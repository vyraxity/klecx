import { execSync } from "node:child_process";
import { E2E_DATABASE_URL } from "./env.mjs";

/** Brings the end-to-end database up to date (it's created by CI or the developer). */
export default function globalSetup() {
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });
}
