import "server-only";
import packageJson from "@/package.json";

/**
 * Step 9.1: the app version (package.json) and, on Vercel, the deployed
 * commit. Read on the server and passed to the pages that show them, so the
 * browser bundle never includes package.json.
 */
export function getAppVersionInfo(): { version: string; build: string | null } {
  return {
    version: packageJson.version,
    build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
  };
}
