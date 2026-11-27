/**
 * Images from Cloudinary's delivery network load **without cookies**
 * (`crossOrigin="anonymous"`) and without a referrer. Otherwise the browser
 * sends every cookie it holds for cloudinary.com (a Cloudinary dashboard
 * sign-in, Cloudinary's own analytics, Cloudflare's `_cfuvid`) with each
 * avatar or picture, which Lighthouse reports as third-party cookies and
 * tells Cloudinary which pages show which images. Cloudinary's delivery
 * network allows any site to load its images anonymously (a CORS header), so
 * they still show.
 *
 * Only `res.cloudinary.com`: signed private downloads (`api.cloudinary.com`,
 * `privateUrl()`) and other hosts are left as they are.
 */
const NO_COOKIE_IMAGE_HOSTS = new Set(["res.cloudinary.com"]);

export interface NoCookieImageProps {
  crossOrigin?: "anonymous";
  referrerPolicy?: "no-referrer";
}

export function noCookieImageProps(src: unknown): NoCookieImageProps {
  if (typeof src !== "string" || !src.startsWith("https://")) return {};
  try {
    return NO_COOKIE_IMAGE_HOSTS.has(new URL(src).hostname)
      ? { crossOrigin: "anonymous", referrerPolicy: "no-referrer" }
      : {};
  } catch {
    return {};
  }
}
