import { expect, test, ask, composer, newUser } from "./helpers";
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

/**
 * Keyboard walkthrough (Step 10.5): everything below is done without the
 * mouse — skip link, sidebar shortcut, command palette, composer, a dialog
 * with focus returning to its button, and the selection toolbar shortcuts.
 */
test("keyboard walkthrough", async ({ browser }) => {
  test.setTimeout(150_000);
  const { page } = await newUser(browser, "keyboard");
  await page.goto("/workspaces");
  await page.waitForLoadState("networkidle");

  // 1. The first Tab stop skips to the main content.
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();

  // 2. "[" collapses and expands the sidebar.
  const toggle = page.getByRole("button", { name: /Collapse sidebar|Expand sidebar/ }).first();
  const before = await toggle.getAttribute("aria-expanded");
  await page.keyboard.press("[");
  await expect(toggle).not.toHaveAttribute("aria-expanded", before ?? "");
  await page.keyboard.press("[");
  await expect(toggle).toHaveAttribute("aria-expanded", before ?? "");

  // 3. Ctrl+K opens the command palette; Escape closes it.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // 4. Tab reaches the composer; Enter sends.
  const box = composer(page);
  await expect(async () => {
    await page.keyboard.press("Tab");
    await expect(box).toBeFocused({ timeout: 300 });
  }).toPass({ timeout: 20_000 });
  await page.keyboard.type("Explain tides in one paragraph");
  await page.keyboard.press("Enter");
  await expect(page.getByText("A closing sentence ends the answer.")).toBeVisible();
  await page.waitForLoadState("networkidle");

  // 5. A dialog opened from the keyboard gives focus back to its button on Escape.
  const shareButton = page.getByRole("banner").getByRole("button", { name: "Share" });
  const share = page.getByRole("dialog", { name: /^Share/ });
  // Right after the first answer the page can still be settling and drop the
  // key press (see openShare): press again until the dialog is open.
  await expect(async () => {
    if (!(await share.isVisible())) {
      await shareButton.focus();
      await page.keyboard.press("Enter");
    }
    await expect(share).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(share.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(share).toHaveCount(0);
  await expect(shareButton).toBeFocused();

  // 6. Text selected with the keyboard (as Shift+arrows would) → Ctrl+Alt+M comments, Escape cancels.
  const answer = page.locator("main").getByText("A closing sentence ends the answer.").first();
  const toolbar = page.getByRole("toolbar", { name: "Annotation actions" });
  // The text can re-render right after the answer is saved: select again until the toolbar shows.
  await expect(async () => {
    await answer.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }, undefined, { timeout: 3_000 });
    await expect(toolbar).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 25_000 });
  await page.keyboard.press("Control+Alt+KeyM");
  const comment = page.getByRole("textbox", { name: "Comment text" });
  await expect(comment).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(comment).toHaveCount(0);
});
