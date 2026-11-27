import type { Page } from "@playwright/test";
import { E2E_BASE_URL } from "./env.mjs";
import { expect, test, newUser } from "./helpers";

/**
 * Journey 15 (Step 10.5): the pseudo-locale en-XA (every text ~30 % longer,
 * accented and bracketed; test mode and development only) on the main pages,
 * on a desktop and a phone width: no sideways page scroll and no button or
 * link whose text is cut off. Catches layouts that only fit English.
 */
const PUBLIC = ["/", "/pricing", "/features", "/help", "/auth/login", "/auth/register"];
const APP = ["/workspaces", "/settings/profile", "/settings/billing", "/settings/usage", "/settings/voice", "/settings/data"];

async function usePseudoLocale(page: Page) {
  await page.context().addCookies([{ name: "NEXT_LOCALE", value: "en-XA", url: E2E_BASE_URL }]);
}

async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) problems.push(`page scrolls sideways (${doc.scrollWidth}px > ${window.innerWidth}px)`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=tab], label"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || el.offsetParent === null) continue;
      if (el.closest("[aria-hidden=true], .sr-only, [data-overflow-ok]")) continue;
      const text = (el.innerText || "").trim();
      if (!text) continue;
      const clipsX = /hidden|clip/.test(style.overflowX) && style.textOverflow !== "ellipsis";
      // Text wider than its box and cut off without an ellipsis (truncate classes add one).
      if (clipsX && el.scrollWidth > el.clientWidth + 2) problems.push(`clipped: "${text.slice(0, 40)}"`);
    }
    return problems;
  });
}

for (const size of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(`pseudo-locale on ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test(`public pages fit longer text (${size.name})`, async ({ page }) => {
      test.setTimeout(120_000);
      await usePseudoLocale(page);
      for (const path of PUBLIC) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        // The pseudo-locale is on: texts are bracketed and padded.
        await expect(page.locator("body")).toContainText("·");
        expect.soft(await layoutProblems(page), `${path} (${size.name})`).toEqual([]);
      }
    });

    test(`app pages fit longer text (${size.name})`, async ({ browser }) => {
      test.setTimeout(150_000);
      const user = await newUser(browser, `pseudo${size.name}`);
      await user.page.setViewportSize({ width: size.width, height: size.height });
      await usePseudoLocale(user.page);
      for (const path of APP) {
        await user.page.goto(path);
        await user.page.waitForLoadState("networkidle");
        await expect(user.page.locator("body")).toContainText("·");
        expect.soft(await layoutProblems(user.page), `${path} (${size.name})`).toEqual([]);
      }
    });
  });
}
