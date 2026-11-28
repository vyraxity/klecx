import type { Page } from "@playwright/test";
import { expect, test, ask, newUser, selectText } from "./helpers";

/**
 * Pre-10.6 fix PR 3: the top bar follows the page in the URL. Settings shows
 * "Back to <page>" (the exact page, thread column included) and none of the
 * last workspace's actions; the Comments & Asks panel lists comments and
 * answered Asks with a count on its button, and long text wraps.
 */
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Annotation actions" });
const topbar = (page: Page) => page.getByTestId("topbar");

async function goClientSide(page: Page, href: string) {
  // Like a click in the app: no full page load, so nothing is reset.
  await page.evaluate((h) => {
    (window as unknown as { next: { router: { push: (x: string) => void } } }).next.router.push(h);
  }, href);
}

test("Comments & Asks badge and panel; Settings links back to the workspace", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await newUser(browser, "topbar");
  await page.setViewportSize({ width: 1440, height: 900 });
  await ask(page, "Explain clouds");
  const workspaceUrl = new URL(page.url()).pathname;
  const main = page.locator("main");

  const longLink = `https://example.com/${"segment/".repeat(12)}end`;
  await selectText(page, main.getByText("A closing sentence ends the answer.").first());
  await toolbar(page).getByRole("button", { name: "Comment" }).click();
  await toolbar(page).getByRole("textbox", { name: "Comment text" }).fill(`See ${longLink}`);
  await toolbar(page).getByRole("button", { name: "Save" }).click();

  // A queued question is not counted: it lives in the queue popover.
  await selectText(page, main.getByText("Point two: a supporting detail.").first());
  await toolbar(page).getByRole("button", { name: "Ask", exact: true }).click();
  await toolbar(page).getByRole("textbox", { name: "Ask question text" }).fill("Queued?");
  await toolbar(page).getByRole("button", { name: /Add to queue/ }).click();
  await page.keyboard.press("Escape");

  const toggle = topbar(page).getByRole("button", { name: "Comments & Asks (1)" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const panel = page.getByRole("dialog", { name: /Comments & Asks/ });
  await expect(panel.getByRole("tab")).toHaveCount(2);
  await expect(panel.getByTestId("drawer-queued-hint")).toBeVisible();
  // The long link wraps inside the card instead of running past the panel.
  const card = panel.locator('[data-testid^="drawer-item-"]').first();
  const panelBox = (await panel.boundingBox())!;
  const scroll = await card.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(scroll.sw).toBeLessThanOrEqual(scroll.cw + 1);
  expect((await card.boundingBox())!.x + (await card.boundingBox())!.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  await page.keyboard.press("Escape");

  await goClientSide(page, "/settings/profile");
  await page.waitForURL(/\/settings\/profile/);
  await expect(topbar(page).getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(topbar(page).getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(topbar(page).getByRole("button", { name: /Comments & Asks/ })).toHaveCount(0);
  await expect(topbar(page).getByRole("button", { name: "Workspace options" })).toHaveCount(0);
  await topbar(page).getByRole("link", { name: /^Back to / }).click();
  await page.waitForURL((url) => url.pathname === workspaceUrl);
  await expect(topbar(page).getByRole("button", { name: "Comments & Asks (1)" })).toBeVisible();
});

test("Settings opened directly links back to the workspaces", async ({ browser }) => {
  const { page } = await newUser(browser, "topbar-direct");
  await page.goto("/settings/security");
  const back = topbar(page).getByRole("link", { name: "Back to Workspaces" });
  await expect(back).toHaveAttribute("href", "/workspaces");
});
