/**
 * Step 10.1 — Content-Security-Policy.
 *
 * Built per request in `proxy.ts` with a fresh nonce. Next.js reads the nonce
 * from the request's CSP header and puts it on its own scripts; our one inline
 * script (the theme initializer in `app/layout.tsx`) reads it from `x-nonce`.
 * `'strict-dynamic'` lets those trusted scripts load the app's chunks.
 *
 * Enforced by default. `CSP_REPORT_ONLY=true` sends the same policy as
 * `Content-Security-Policy-Report-Only` (a switch for the hosting dashboard
 * if something breaks: no code change, just a redeploy).
 *
 * Keep the hosts in line with what the browser actually loads:
 * - images: Cloudinary (files, avatars, generated images) and OAuth avatars,
 *   the same list as `components/markdown/safe-image.tsx` and `next.config.mjs`;
 * - media: read-aloud audio and voice samples (signed Cloudinary URLs);
 * - connect: direct uploads to Cloudinary (`server/storage/cloudinary.ts`).
 */

export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp";

export const CSP_IMAGE_HOSTS = [
  "https://res.cloudinary.com",
  "https://lh3.googleusercontent.com",
  "https://avatars.githubusercontent.com",
] as const;

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // WebAssembly only (the code highlighter's regex engine), never JS eval.
    "'wasm-unsafe-eval'",
    // React needs eval in development only (better stack traces).
    ...(opts.dev ? ["'unsafe-eval'"] : []),
  ];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    // Tailwind, KaTeX and Radix set inline styles; styles can't run code.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", ...CSP_IMAGE_HOSTS]],
    ["media-src", ["'self'", "blob:", "https://res.cloudinary.com"]],
    ["font-src", ["'self'", "data:"]],
    [
      "connect-src",
      [
        "'self'",
        "https://api.cloudinary.com",
        "https://res.cloudinary.com",
        // Webpack/Turbopack hot reload in development.
        ...(opts.dev ? ["ws:", "wss:"] : []),
      ],
    ],
    ["worker-src", ["'self'", "blob:"]],
    ["frame-src", ["https://checkout.creem.io"]],
    ["frame-ancestors", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["report-uri", [CSP_REPORT_PATH]],
    ["report-to", [CSP_REPORT_GROUP]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

export function cspHeaderName(reportOnly: boolean): string {
  return reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

/** Value of the `Reporting-Endpoints` header that `report-to csp` points at. */
export function reportingEndpointsHeader(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
}
