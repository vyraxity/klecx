import { buildSecurityTxt } from "@/server/security/security-txt";

export const dynamic = "force-dynamic";

/** Step 10.1: RFC 9116 security contact (server/security/security-txt.ts). */
export function GET() {
  return new Response(buildSecurityTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
