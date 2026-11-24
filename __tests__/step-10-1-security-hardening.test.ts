/**
 * @jest-environment node
 */
import fs from "fs";
import path from "path";

let mockActor: { userId: string; role: string; sessionId: string; email: string } | null = null;
jest.mock("../server/auth/session", () => ({
  getActor: jest.fn(async () => mockActor),
}));

import { NextRequest } from "next/server";
import { z } from "zod";
import { buildCsp, cspHeaderName, createNonce, CSP_IMAGE_HOSTS } from "@/lib/security/csp";
import {
  MAX_JSON_BODY_BYTES,
  isAllowedRequestOrigin,
  sanitizeJsonStrings,
  stripControlChars,
} from "@/lib/security/input";
import { parseCspReport } from "@/server/security/csp-report";
import { countInRange, isPasswordPwned, shouldRefusePassword } from "@/server/auth/pwned-passwords";
import { buildSecurityTxt } from "@/server/security/security-txt";
import { route } from "@/server/http/route";
import { resetInMemoryRateLimits } from "@/server/http/rate-limit";
import { POST as cspReportPOST } from "@/app/api/csp-report/route";
import { proxy } from "@/proxy";

const APP = "http://localhost:3000";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe("Step 10.1 — Content-Security-Policy", () => {
  test("strict nonce policy: no unsafe-inline/eval scripts, framing and plugins blocked", () => {
    const nonce = createNonce();
    const csp = buildCsp(nonce);
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-src https://checkout.creem.io");
    expect(csp).toContain("media-src 'self' blob: https://res.cloudinary.com");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).toContain("report-to csp");
    for (const host of CSP_IMAGE_HOSTS) expect(csp).toContain(host);
  });

  test("WebAssembly may compile (code highlighter), JavaScript eval may not", () => {
    expect(buildCsp("n")).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
  });

  test("isomorphic code never imports Node's crypto (a big polyfill and a CSP eval probe in the browser)", () => {
    for (const f of walk("lib").filter((x) => /\.tsx?$/.test(x))) {
      const src = fs.readFileSync(f, "utf8");
      expect([f, /from ["'](node:)?crypto["']/.test(src)]).toEqual([f, false]);
    }
  });

  test("development adds eval and hot-reload sockets only", () => {
    expect(buildCsp("n", { dev: true })).toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(buildCsp("n", { dev: true })).toMatch(/connect-src[^;]*ws:/);
    expect(buildCsp("n")).not.toMatch(/connect-src[^;]*ws:/);
  });

  test("every request gets a fresh nonce", () => {
    expect(createNonce()).not.toBe(createNonce());
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  test("image hosts match the Markdown image allow-list", () => {
    const src = fs.readFileSync("components/markdown/safe-image.tsx", "utf8");
    for (const host of CSP_IMAGE_HOSTS) expect(src).toContain(new URL(host).hostname);
  });

  test("enforced by default; CSP_REPORT_ONLY=true switches to report-only", async () => {
    expect(cspHeaderName(false)).toBe("Content-Security-Policy");
    expect(cspHeaderName(true)).toBe("Content-Security-Policy-Report-Only");

    const page = await proxy(new NextRequest(`${APP}/pricing`));
    const enforced = page.headers.get("content-security-policy");
    expect(enforced).toMatch(/'nonce-[^']+'/);
    expect(page.headers.get("reporting-endpoints")).toBe('csp="/api/csp-report"');
    // The nonce reaches the page through the request headers.
    const nonce = enforced!.match(/'nonce-([^']+)'/)![1];
    expect(page.headers.get("x-middleware-request-x-nonce")).toBe(nonce);

    process.env.CSP_REPORT_ONLY = "true";
    try {
      const ro = await proxy(new NextRequest(`${APP}/pricing`));
      expect(ro.headers.get("content-security-policy")).toBeNull();
      expect(ro.headers.get("content-security-policy-report-only")).toMatch(/'nonce-/);
    } finally {
      delete process.env.CSP_REPORT_ONLY;
    }

    // Redirects carry it too; API responses don't need it.
    const redirect = await proxy(new NextRequest(`${APP}/workspaces`));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("content-security-policy")).toMatch(/'nonce-/);
    const api = await proxy(new NextRequest(`${APP}/api/v1/me`));
    expect(api.headers.get("content-security-policy")).toBeNull();
  });

  test("the theme script in the root layout carries the nonce", () => {
    const layout = fs.readFileSync("app/layout.tsx", "utf8");
    expect(layout).toContain('(await headers()).get("x-nonce")');
    expect(layout).toMatch(/<script nonce=\{nonce\}/);
  });
});

describe("Step 10.1 — CSP reports", () => {
  beforeEach(() => resetInMemoryRateLimits());

  test("keeps only directive, blocked origin and page path (no query, no sample)", () => {
    const legacy = parseCspReport(
      JSON.stringify({
        "csp-report": {
          "document-uri": "https://klecx.com/workspaces/abc?token=secret",
          "violated-directive": "script-src-elem",
          "effective-directive": "script-src-elem",
          "blocked-uri": "https://evil.example/x.js?session=secret",
          "script-sample": "alert(document.cookie)",
        },
      })
    );
    expect(legacy).toEqual([
      { directive: "script-src-elem", blocked: "https://evil.example", page: "/workspaces/abc", disposition: "enforce" },
    ]);
    expect(JSON.stringify(legacy)).not.toContain("secret");
    expect(JSON.stringify(legacy)).not.toContain("cookie");

    const modern = parseCspReport(
      JSON.stringify([
        { type: "csp-violation", body: { documentURL: "https://klecx.com/pricing", effectiveDirective: "img-src", blockedURL: "data", disposition: "report" } },
        { type: "deprecation", body: {} },
      ])
    );
    expect(modern).toEqual([{ directive: "img-src", blocked: "data", page: "/pricing", disposition: "report" }]);
    expect(parseCspReport("not json")).toEqual([]);
  });

  test("the endpoint answers 204, logs no body and ignores oversized reports", async () => {
    const { log } = await import("@/server/log");
    const warn = jest.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const body = JSON.stringify({ "csp-report": { "document-uri": "https://klecx.com/a?x=1", "effective-directive": "img-src", "blocked-uri": "https://x.example/p.png?q=secret" } });
      const res = await cspReportPOST(new NextRequest(`${APP}/api/csp-report`, { method: "POST", body, headers: { "content-type": "application/csp-report" } }));
      expect(res.status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain("secret");

      const big = await cspReportPOST(new NextRequest(`${APP}/api/csp-report`, { method: "POST", body: "x".repeat(20_000) }));
      expect(big.status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Step 10.1 — origin check (CSRF)", () => {
  const req = (method: string, headers: Record<string, string>) => ({
    method,
    headers: new Headers(headers),
  });

  test("reads are never blocked", () => {
    expect(isAllowedRequestOrigin(req("GET", { origin: "https://evil.example" }), APP)).toBe(true);
  });

  test("cookie requests from another origin or site are refused", () => {
    expect(isAllowedRequestOrigin(req("POST", { origin: "https://evil.example" }), APP)).toBe(false);
    expect(isAllowedRequestOrigin(req("DELETE", { "sec-fetch-site": "cross-site" }), APP)).toBe(false);
    expect(isAllowedRequestOrigin(req("PATCH", { "sec-fetch-site": "same-site" }), APP)).toBe(false);
    expect(isAllowedRequestOrigin(req("POST", { origin: "null" }), APP)).toBe(false);
  });

  test("same-origin, Bearer and non-browser requests are allowed", () => {
    expect(isAllowedRequestOrigin(req("POST", { origin: APP, "sec-fetch-site": "same-origin" }), APP)).toBe(true);
    expect(isAllowedRequestOrigin(req("POST", { origin: "https://evil.example", authorization: "Bearer tok" }), APP)).toBe(true);
    expect(isAllowedRequestOrigin(req("POST", {}), APP)).toBe(true);
  });

  test("route() answers 403 origin_mismatch before doing anything", async () => {
    mockActor = { userId: "u1", role: "USER", sessionId: "s1", email: "u@example.com" };
    const handler = jest.fn(async () => ({ ok: true }));
    const POST = route({ body: z.object({ a: z.string() }), handler });
    const res = await POST(
      new NextRequest(`${APP}/api/v1/x`, {
        method: "POST",
        body: JSON.stringify({ a: "b" }),
        headers: { origin: "https://evil.example", "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("origin_mismatch");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("Step 10.1 — input hygiene in route()", () => {
  beforeEach(() => {
    resetInMemoryRateLimits();
    mockActor = { userId: "u1", role: "USER", sessionId: "s1", email: "u@example.com" };
  });

  test("control characters are stripped, tabs and newlines kept", () => {
    expect(stripControlChars("a\u0000b\u0007c\td\ne\rf\u007f")).toBe("abc\td\ne\rf");
    expect(sanitizeJsonStrings({ "k\u0000": ["x\u0001", { y: "z\u001f" }], n: 1, b: true, z: null })).toEqual({
      k: ["x", { y: "z" }],
      n: 1,
      b: true,
      z: null,
    });
  });

  test("bodies and queries reach the handler without control characters", async () => {
    let seen: unknown;
    const POST = route({
      body: z.object({ text: z.string() }),
      query: z.object({ q: z.string() }),
      handler: async (c) => {
        seen = { body: c.body, query: c.query };
        return null;
      },
    });
    const res = await POST(
      new NextRequest(`${APP}/api/v1/x?q=a%00b`, { method: "POST", body: JSON.stringify({ text: "hi\u0000 there\n" }) })
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ body: { text: "hi there\n" }, query: { q: "ab" } });
  });

  test("JSON bodies over 1 MB are refused with 413", async () => {
    const handler = jest.fn(async () => null);
    const POST = route({ body: z.object({ text: z.string() }), handler });
    const big = JSON.stringify({ text: "x".repeat(MAX_JSON_BODY_BYTES) });
    const res = await POST(new NextRequest(`${APP}/api/v1/x`, { method: "POST", body: big }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect(handler).not.toHaveBeenCalled();

    const declared = await POST(
      new NextRequest(`${APP}/api/v1/x`, {
        method: "POST",
        body: JSON.stringify({ text: "a" }),
        headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
      })
    );
    expect(declared.status).toBe(413);
  });

  test("the largest legitimate body (a 200,000-character edit) still fits", () => {
    const edit = JSON.stringify({ content: "é".repeat(200_000), versionId: "v" });
    expect(Buffer.byteLength(edit, "utf8")).toBeLessThan(MAX_JSON_BODY_BYTES);
  });
});

describe("Step 10.1 — leaked-password check", () => {
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const okRange = (lines: string) =>
    jest.fn(async () => new Response(lines, { status: 200 })) as unknown as typeof fetch;

  test("sends only the 5-character hash prefix", async () => {
    const f = okRange("1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\nAAAA:0");
    await expect(isPasswordPwned("password", f)).resolves.toBe(true);
    const url = String((f as unknown as jest.Mock).mock.calls[0][0]);
    expect(url).toBe("https://api.pwnedpasswords.com/range/5BAA6");
    expect(url).not.toContain("1E4C9B93"); // never the rest of the hash
  });

  test("padding lines (count 0) and absent hashes are not breaches", async () => {
    expect(countInRange("1E4C9B93F3F0682250B6CF8331B7EE68FD8:0\nFFFF:2", "1E4C9B93F3F0682250B6CF8331B7EE68FD8")).toBe(0);
    await expect(isPasswordPwned("password", okRange("FFFF:2"))).resolves.toBe(false);
  });

  test("fails open when the service is down", async () => {
    const down = jest.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(isPasswordPwned("password", down)).resolves.toBeNull();
    const bad = jest.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(isPasswordPwned("password", bad)).resolves.toBeNull();
  });

  test("shouldRefusePassword is off in tests unless PWNED_PASSWORD_CHECK is forced", async () => {
    const f = okRange("1E4C9B93F3F0682250B6CF8331B7EE68FD8:5");
    await expect(shouldRefusePassword("password", f)).resolves.toBe(false); // NODE_ENV=test
    const prev = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: "production" });
    try {
      await expect(shouldRefusePassword("password", f)).resolves.toBe(true);
      process.env.PWNED_PASSWORD_CHECK = "false";
      await expect(shouldRefusePassword("password", f)).resolves.toBe(false);
    } finally {
      delete process.env.PWNED_PASSWORD_CHECK;
      Object.assign(process.env, { NODE_ENV: prev });
    }
  });

  test("hooked into sign-up, reset, Better Auth's change/set password and our own change", () => {
    const auth = fs.readFileSync("server/auth/auth.ts", "utf8");
    expect(auth).toContain("PASSWORD_SETTING_PATHS[ctx.path]");
    expect(auth).toContain('code: "PASSWORD_COMPROMISED"');
    const service = fs.readFileSync("server/services/account-security.ts", "utf8");
    expect(service).toMatch(/shouldRefusePassword\(input\.newPassword\)/);
    for (const locale of ["en", "es", "fr"]) {
      const m = JSON.parse(fs.readFileSync(`messages/${locale}.json`, "utf8"));
      expect(m.Auth.errors.PASSWORD_COMPROMISED).toBeTruthy();
      expect(m.Errors.api.PASSWORD_COMPROMISED).toBeTruthy();
      expect(m.Errors.api.origin_mismatch).toBeTruthy();
      expect(m.Errors.api.payload_too_large).toBeTruthy();
    }
  });
});

describe("Step 10.1 — security.txt", () => {
  test("RFC 9116 fields, a year ahead, pointing at the disclosure policy", () => {
    const txt = buildSecurityTxt(new Date("2026-11-23T10:00:00Z"));
    expect(txt).toMatch(/^Contact: mailto:\S+@\S+$/m);
    expect(txt).toContain("Expires: 2027-11-23T10:00:00Z");
    expect(txt).toMatch(/^Canonical: http\S+\/\.well-known\/security\.txt$/m);
    expect(txt).toMatch(/^Policy: http\S+\/acceptable-use#security$/m);
    for (const locale of ["en", "es", "fr"]) {
      const m = JSON.parse(fs.readFileSync(`messages/${locale}.json`, "utf8"));
      const section = m.Legal.acceptableUse.sections.find((s: { id: string }) => s.id === "security");
      expect(section.paragraphs[0]).toContain("{securityEmail}");
    }
  });
});

describe("Step 10.1 — static rules", () => {
  const sources = ["app", "server", "lib", "components", "proxy.ts"].flatMap((p) =>
    fs.statSync(p).isDirectory() ? walk(p) : [p]
  ).filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.includes("server/db/generated"));

  test("no unsafe raw SQL anywhere, and ESLint bans it", () => {
    for (const f of sources) {
      expect([f, /\$(query|execute)RawUnsafe/.test(fs.readFileSync(f, "utf8"))]).toEqual([f, false]);
    }
    const eslint = fs.readFileSync("eslint.config.mjs", "utf8");
    expect(eslint).toContain('property: "$queryRawUnsafe"');
    expect(eslint).toContain('property: "$executeRawUnsafe"');
  });

  test("CORS: no route opens the API to other origins", () => {
    for (const f of sources) {
      expect([f, /Access-Control-Allow-Origin/i.test(fs.readFileSync(f, "utf8"))]).toEqual([f, false]);
    }
    const config = fs.readFileSync("next.config.mjs", "utf8");
    expect(config).not.toMatch(/Access-Control-Allow/i);
  });

  test("no secret-looking server variable is exposed as NEXT_PUBLIC_*", () => {
    const names = new Set<string>();
    for (const f of [...sources, ".env.example"]) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(m[0]);
    }
    for (const n of names) expect([n, /SECRET|KEY|TOKEN|PASSWORD|PRIVATE/.test(n)]).toEqual([n, false]);
  });

  test("the unauthenticated email-sending leftover is gone", () => {
    expect(fs.existsSync("app/api/email/send-verification-email/route.ts")).toBe(false);
  });

  test("files served from our origin are sandboxed", () => {
    for (const f of [
      "app/api/v1/favicon/route.ts",
      "app/api/v1/attachments/[id]/download/route.ts",
      "app/api/v1/documents/[id]/download/route.ts",
    ]) {
      expect([f, /sandbox/.test(fs.readFileSync(f, "utf8"))]).toEqual([f, true]);
    }
    expect(fs.readFileSync("app/api/v1/favicon/route.ts", "utf8")).not.toMatch(/"image\/svg\+xml",\n\s*"image\/webp"/);
  });

  test("every route handler goes through route() or is a known exception", () => {
    const known = new Set([
      "app/api/auth/[...all]/route.ts", // Better Auth: own origin check (trustedOrigins) and rate limits
      "app/api/webhooks/creem/route.ts", // signed by Creem
      "app/api/health/route.ts",
      "app/api/ready/route.ts",
      "app/api/csp-report/route.ts", // browser reports, rate-limited per IP
      "app/api/v1/favicon/route.ts", // public images, rate-limited per IP
      "app/api/v1/s/[token]/route.ts", // public share links, own rate limit
      "app/.well-known/security.txt/route.ts",
      "app/sentry-tunnel/route.ts", // Step 10.2: Sentry's relay (accepts only our DSN, forwards no cookies)
    ]);
    const handlers = [...walk("app")].filter((f) => f.endsWith("route.ts"));
    for (const f of handlers) {
      const usesRoute = /from "@\/server\/http\/route"/.test(fs.readFileSync(f, "utf8"));
      expect([f, usesRoute || known.has(f)]).toEqual([f, true]);
    }
  });
});
