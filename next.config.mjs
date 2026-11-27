import createNextIntlPlugin from "next-intl/plugin";
import { createRequire } from "node:module";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
    ],
  },
  async redirects() {
    return [
      {
        source: "/login",
        destination: "/auth/login",
        permanent: false,
      },
      {
        source: "/chat/:id",
        destination: "/workspaces/:id",
        permanent: true,
      },
      {
        source: "/chat",
        destination: "/workspaces",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          // Cuts the link between Klecx's pages and windows of other sites
          // (window.opener). Safe: sign-in and checkout are redirects, not
          // popups, and the one window Klecx opens (Help) is same-origin.
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          // The Content-Security-Policy is set per request in proxy.ts (it
          // carries a nonce): lib/security/csp.ts (Step 10.1).
        ],
      },
      {
        source: "/workspaces/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      },
      {
        source: "/projects/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      },
      {
        source: "/settings/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      },
      {
        source: "/s/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      },
    ];
  },
};

/**
 * Step 10.2: Sentry only wraps the build when it's configured
 * (NEXT_PUBLIC_SENTRY_DSN). Source maps are uploaded when SENTRY_AUTH_TOKEN,
 * SENTRY_ORG and SENTRY_PROJECT are set in the build environment, then deleted
 * so they're never served. The browser reaches Sentry through /sentry-tunnel
 * (app/sentry-tunnel/route.ts), set in instrumentation-client.ts.
 */
const sentryEnabled = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

// Loaded only when configured (and as CommonJS, which every loader of this file supports).
const withSentryConfig = sentryEnabled
  ? createRequire(import.meta.url)("@sentry/nextjs").withSentryConfig
  : null;

export default withSentryConfig
  ? withSentryConfig(withNextIntl(nextConfig), {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      widenClientFileUpload: true,
      sourcemaps: {
        disable: !process.env.SENTRY_AUTH_TOKEN,
        deleteSourcemapsAfterUpload: true,
      },
      telemetry: false,
    })
  : withNextIntl(nextConfig);
