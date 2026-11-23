import { NextRequest } from "next/server";
import { getClientIp, limit } from "@/server/http/rate-limit";
import { ApiError } from "@/server/http/errors";
import { CSP_REPORT_MAX_BYTES, parseCspReport } from "@/server/security/csp-report";

export const dynamic = "force-dynamic";

/**
 * Step 10.1: browsers post Content-Security-Policy violations here
 * (`report-uri` / `report-to csp` in lib/security/csp.ts). No sign-in (the
 * browser sends them on its own), rate-limited per IP, and only the directive,
 * blocked origin and page path are logged (server/security/csp-report.ts).
 * Always answers 204 so a report never shows an error in the console.
 */
export async function POST(req: NextRequest) {
  const done = () => new Response(null, { status: 204 });
  try {
    await limit("csp:report", getClientIp(req) ?? "anonymous");
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return done();
    throw e;
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > CSP_REPORT_MAX_BYTES) return done();
  const text = await req.text().catch(() => "");
  if (!text || text.length > CSP_REPORT_MAX_BYTES) return done();

  for (const v of parseCspReport(text)) {
    console.warn({ event: "csp_violation", ...v });
  }
  return done();
}
