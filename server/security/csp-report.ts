import "server-only";

/**
 * Step 10.1 — CSP violation reports.
 *
 * Browsers send either the old `application/csp-report` body
 * (`{ "csp-report": { … } }`) or the Reporting API's `application/reports+json`
 * (`[{ type: "csp-violation", body: { … } }]`). We keep only what tells us which
 * rule fired and where: the directive, the blocked origin (never its path or
 * query) and the page path (never its query). Nothing else from the body is
 * logged: reports can carry URLs with tokens and snippets of page text.
 */
export type CspViolation = {
  directive: string;
  blocked: string;
  page: string;
  disposition: string;
};

/** Reports larger than this are ignored. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;

const MAX_REPORTS = 10;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function originOnly(raw: string | undefined): string {
  if (!raw) return "unknown";
  // Keywords such as "inline", "eval", "data", "blob".
  if (!raw.includes(":") || /^(data|blob|inline|eval|wasm-eval|trusted-types-sink)/.test(raw)) {
    return (raw.split(":")[0] ?? "unknown").slice(0, 40);
  }
  try {
    return new URL(raw).origin.slice(0, 200);
  } catch {
    return "invalid";
  }
}

function pathOnly(raw: string | undefined): string {
  if (!raw) return "unknown";
  try {
    return new URL(raw).pathname.slice(0, 200);
  } catch {
    return "invalid";
  }
}

function shortDirective(raw: string | undefined): string {
  return (raw ?? "unknown").split(" ")[0]!.replace(/[^a-z-]/gi, "").slice(0, 40) || "unknown";
}

function fromBody(body: Record<string, unknown>): CspViolation {
  return {
    directive: shortDirective(
      str(body["effective-directive"]) ??
        str(body.effectiveDirective) ??
        str(body["violated-directive"]) ??
        str(body.violatedDirective)
    ),
    blocked: originOnly(str(body["blocked-uri"]) ?? str(body.blockedURL)),
    page: pathOnly(str(body["document-uri"]) ?? str(body.documentURL)),
    disposition: str(body.disposition) === "report" ? "report" : "enforce",
  };
}

/** Parses a report body; returns the violations (at most 10) or [] when it isn't one. */
export function parseCspReport(text: string): CspViolation[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const out: CspViolation[] = [];
  if (Array.isArray(json)) {
    for (const r of json.slice(0, MAX_REPORTS)) {
      if (r && typeof r === "object" && (r as { type?: unknown }).type === "csp-violation") {
        const body = (r as { body?: unknown }).body;
        if (body && typeof body === "object") out.push(fromBody(body as Record<string, unknown>));
      }
    }
  } else if (json && typeof json === "object") {
    const body = (json as Record<string, unknown>)["csp-report"];
    if (body && typeof body === "object") out.push(fromBody(body as Record<string, unknown>));
  }
  return out;
}
