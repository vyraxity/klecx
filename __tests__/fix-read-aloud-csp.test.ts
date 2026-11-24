/**
 * @jest-environment node
 *
 * Fix (2026-11-24, found on dev.klecx.com): read-aloud audio, voice samples
 * and private images (message images, generated images, shared pages) are
 * signed download links from `privateUrl()` on `api.cloudinary.com`, which the
 * CSP's `media-src` / `img-src` didn't allow, so the browser blocked them.
 * These tests take real links from the Cloudinary adapter and check the
 * policy allows them, for every kind of private file the browser loads.
 */
import { buildCsp, CSP_IMAGE_HOSTS } from "@/lib/security/csp";
import { CloudinaryStorageProvider } from "@/server/storage/cloudinary";

/** The sources of one directive. */
function sources(csp: string, directive: string): string[] {
  const part = csp.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${directive} `));
  return part ? part.split(/\s+/).slice(1) : [];
}

/** Whether a host source (scheme + host, no path) allows the URL. */
function allows(csp: string, directive: string, url: string): boolean {
  const origin = new URL(url).origin;
  return sources(csp, directive).some((s) => s === origin || s === `${origin}/`);
}

const storage = new CloudinaryStorageProvider({ cloudName: "demo-cloud", apiKey: "123456789012345", apiSecret: "test-secret-not-real" });
const csp = buildCsp("nonce");

describe("private files are allowed by the CSP", () => {
  test("read-aloud audio and voice samples (media-src)", async () => {
    const url = await storage.privateUrl("klecx/dev/speech/abc", { resourceType: "video", format: "mp3", expiresInSeconds: 3600 });
    expect(new URL(url).hostname).toBe("api.cloudinary.com");
    expect(allows(csp, "media-src", url)).toBe(true);
  });

  test("private images: message attachments, generated images, shared pages (img-src)", async () => {
    const url = await storage.privateUrl("klecx/dev/attachments/x", { resourceType: "image", format: "png" });
    expect(allows(csp, "img-src", url)).toBe(true);
  });

  test("a PDF attachment previewed in its dialog (frame-src), next to Creem's checkout", async () => {
    const url = await storage.privateUrl("klecx/dev/attachments/doc", { resourceType: "raw", format: "pdf" });
    expect(allows(csp, "frame-src", url)).toBe(true);
    expect(allows(csp, "frame-src", "https://checkout.creem.io/x")).toBe(true);
  });

  test("public delivery links stay allowed; the Markdown image allowlist doesn't gain the API host", () => {
    const pub = storage.publicUrl("klecx/dev/avatars/a", { resourceType: "image" });
    expect(allows(csp, "img-src", pub)).toBe(true);
    expect(allows(csp, "media-src", "https://res.cloudinary.com/demo-cloud/video/upload/a.mp3")).toBe(true);
    expect(CSP_IMAGE_HOSTS).not.toContain("https://api.cloudinary.com");
  });

  test("other hosts are still refused", () => {
    expect(allows(csp, "media-src", "https://evil.example/a.mp3")).toBe(false);
    expect(allows(csp, "img-src", "https://evil.example/a.png")).toBe(false);
    expect(allows(csp, "frame-src", "https://evil.example/")).toBe(false);
  });
});
