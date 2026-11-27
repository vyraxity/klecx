/**
 * @jest-environment jsdom
 */
import fs from "node:fs";
import React from "react";
import { render } from "@testing-library/react";
import { noCookieImageProps } from "@/lib/images/no-cookie-image";
import { Markdown } from "@/components/markdown";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);

/**
 * Cloudinary images load without cookies or a referrer (Lighthouse reported
 * the viewer's cloudinary.com cookies as third-party cookies on every
 * avatar), and every page sends Cross-Origin-Opener-Policy.
 */
describe("Cloudinary images without cookies", () => {
  const cloudinary = "https://res.cloudinary.com/demo/image/upload/v1/klecx/prod/avatars/a.png";

  it("marks Cloudinary delivery URLs anonymous, and nothing else", () => {
    expect(noCookieImageProps(cloudinary)).toEqual({ crossOrigin: "anonymous", referrerPolicy: "no-referrer" });
    // Signed private downloads, other hosts, local previews: unchanged.
    expect(noCookieImageProps("https://api.cloudinary.com/v1_1/demo/download?x=1")).toEqual({});
    expect(noCookieImageProps("https://lh3.googleusercontent.com/a/photo")).toEqual({});
    expect(noCookieImageProps("https://res.cloudinary.com.evil.example/x.png")).toEqual({});
    expect(noCookieImageProps("http://res.cloudinary.com/x.png")).toEqual({});
    expect(noCookieImageProps("blob:http://localhost/123")).toEqual({});
    expect(noCookieImageProps(undefined)).toEqual({});
    expect(noCookieImageProps("not a url")).toEqual({});
  });

  it("images in answers and documents load without cookies", () => {
    const { container } = render(<Markdown content={`![Chart](${cloudinary})`} />);
    const img = container.querySelector(`img[src="${cloudinary}"]`);
    expect(img).toHaveAttribute("crossorigin", "anonymous");
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("every component that shows a Cloudinary image uses the helper", () => {
    for (const file of [
      "components/ui/avatar.tsx",
      "components/markdown/safe-image.tsx",
      "components/response/prompt-attachment-preview.tsx",
      "components/response/response-card.tsx",
      "components/support/screenshot-picker.tsx",
      "app/s/[token]/page.tsx",
    ]) {
      expect([file, fs.readFileSync(file, "utf8").includes("noCookieImageProps(")]).toEqual([file, true]);
    }
  });
});

describe("Cross-Origin-Opener-Policy", () => {
  it("is sent with every page", () => {
    const config = fs.readFileSync("next.config.mjs", "utf8");
    expect(config).toMatch(/key: "Cross-Origin-Opener-Policy",\s*value: "same-origin"/);
  });
});
