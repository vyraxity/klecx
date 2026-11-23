import { NextResponse } from "next/server";
import { safeFetch } from "@/server/files/safe-fetch";
import { getClientIp, limit } from "@/server/http/rate-limit";

/**
 * Step 10.1: these bytes come from other sites but are served from our origin.
 * Never accept remote SVG (it can carry scripts), and sandbox every response
 * so even a mislabelled file opened directly can't run anything here.
 */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function imageResponse(body: Buffer, mime: string, maxAge: number) {
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": `public, max-age=${maxAge}`,
      "Content-Security-Policy": FILE_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

interface CachedFavicon {
  buffer: Buffer;
  mime: string;
  expiresAt: number;
}

const FAVICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_ENTRIES = 500;
const faviconCache = new Map<string, CachedFavicon>();

const FALLBACK_GLOBE_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
  "utf8"
);

function isValidHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  // Must look like a valid public hostname (no protocol, slashes, ports, or IP literals)
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host)) {
    return false;
  }
  return true;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const rawHost = (searchParams.get("host") || "").trim().toLowerCase();

  if (!isValidHost(rawHost)) {
    return imageResponse(FALLBACK_GLOBE_SVG, "image/svg+xml", 86400);
  }

  const now = Date.now();
  const cached = faviconCache.get(rawHost);
  if (cached && cached.expiresAt > now) {
    return imageResponse(cached.buffer, cached.mime, 86400);
  }

  // Fetching another site costs us a request: cap it per visitor.
  try {
    await limit("favicon:fetch", getClientIp(req) ?? "anonymous");
  } catch {
    return imageResponse(FALLBACK_GLOBE_SVG, "image/svg+xml", 60);
  }

  try {
    const res = await safeFetch(`https://${rawHost}/favicon.ico`, {
      allowedMimes: [
        "image/x-icon",
        "image/vnd.microsoft.icon",
        "image/png",
        "image/webp",
        "image/gif",
        "image/jpeg",
      ],
      maxBytes: 128 * 1024,
      connectTimeoutMs: 2500,
      totalTimeoutMs: 4000,
      checkRobotsTxt: false,
    });

    if (faviconCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = faviconCache.keys().next().value;
      if (oldestKey) faviconCache.delete(oldestKey);
    }

    faviconCache.set(rawHost, {
      buffer: res.buffer,
      mime: res.mime,
      expiresAt: now + FAVICON_CACHE_TTL_MS,
    });

    return imageResponse(res.buffer, res.mime, 86400);
  } catch {
    // Cache fallback briefly so repeated renders don't hammer unreachable hosts
    faviconCache.set(rawHost, {
      buffer: FALLBACK_GLOBE_SVG,
      mime: "image/svg+xml",
      expiresAt: now + 60 * 60 * 1000,
    });

    return imageResponse(FALLBACK_GLOBE_SVG, "image/svg+xml", 3600);
  }
}
