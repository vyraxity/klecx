import { expect, test, ask, newUser } from "./helpers";
import { expectNoA11yViolations } from "./a11y";

/**
 * Journey 14 (Step 10.5): axe on every main page, in the light and the dark
 * theme (the default "system" theme follows the emulated color scheme).
 */
const MARKETING = ["/", "/features", "/pricing", "/about", "/help", "/help/regenerate-vs-edit", "/support", "/status", "/terms", "/privacy", "/cookies", "/acceptable-use"];
const AUTH = ["/auth/login", "/auth/register", "/auth/forgot-password"];
const SETTINGS = ["profile", "security", "sessions", "language", "appearance", "notifications", "billing", "usage", "voice", "data", "support"];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test(`public pages have no axe violations (${scheme})`, async ({ page }) => {
      test.setTimeout(180_000);
      for (const path of [...MARKETING, ...AUTH]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expectNoA11yViolations(page, `${path} (${scheme})`);
      }
    });

    test(`app pages have no axe violations (${scheme})`, async ({ browser }) => {
      test.setTimeout(240_000);
      const user = await newUser(browser, `a11y${scheme}`);
      const { page } = user;
      await page.emulateMedia({ colorScheme: scheme });

      await page.goto("/workspaces");
      await page.waitForLoadState("networkidle");
      await expectNoA11yViolations(page, `/workspaces (${scheme})`);

      // A conversation with an answer (response card, composer, toolbar).
      await ask(page, "Explain photosynthesis briefly");
      await page.waitForLoadState("networkidle");
      await expectNoA11yViolations(page, `workspace (${scheme})`);

      for (const slug of SETTINGS) {
        await page.goto(`/settings/${slug}`);
        await expect(page.locator("main h1").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expectNoA11yViolations(page, `/settings/${slug} (${scheme})`);
      }
    });
  });
}
