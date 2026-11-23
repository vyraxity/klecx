import "server-only";
import { getSiteConfig } from "@/server/config/site";

/**
 * Step 10.1: RFC 9116 security contact. `Expires` is always a year ahead, so
 * the file never goes stale; the address is `SECURITY_EMAIL` (or SUPPORT_EMAIL).
 * The disclosure policy is section "Reporting security issues" of the
 * Acceptable Use Policy.
 */
export function buildSecurityTxt(now: Date = new Date()): string {
  const site = getSiteConfig();
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  return [
    `Contact: mailto:${site.emails.security}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    `Preferred-Languages: en, es, fr`,
    `Canonical: ${site.appUrl}/.well-known/security.txt`,
    `Policy: ${site.appUrl}/acceptable-use#security`,
    "",
  ].join("\n");
}

