import { test, expect, newUser, dismissCookieNotice } from "./helpers";

/**
 * Pre-10.6 fix PR 2 (owner, 2026-11-27): a signed-in visitor sees "Go to your
 * workspaces" on the landing page instead of Sign in / Get started; the help
 * center filters from `/help?q=` and keeps the address bar in step.
 */
test("landing page offers the workspaces to a signed-in visitor, not to others", async ({ browser, page }) => {
  await page.goto("/");
  await dismissCookieNotice(page);
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to your workspaces" })).toHaveCount(0);

  const person = await newUser(browser, "landing");
  await person.page.goto("/");
  const personHeader = person.page.getByRole("banner");
  await expect(personHeader.getByRole("link", { name: "Go to your workspaces" })).toBeVisible();
  await expect(personHeader.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  // Header (desktop), hero and the closing call to action.
  await expect(person.page.getByRole("main").getByRole("link", { name: "Go to your workspaces" }).first()).toBeVisible();
  await personHeader.getByRole("link", { name: "Go to your workspaces" }).click();
  await person.page.waitForURL(/\/workspaces/);
});

test("help center filters from the URL and updates it while typing", async ({ page }) => {
  await page.goto("/help?q=credits");
  await dismissCookieNotice(page);
  const search = page.getByRole("searchbox");
  await expect(search).toHaveValue("credits");
  const results = page.getByRole("link", { name: /credit/i });
  await expect(results.first()).toBeVisible();

  await search.fill("zzzz-no-such-article");
  await expect(page).toHaveURL(/\/help\?q=zzzz-no-such-article$/);
  await expect(page.getByRole("heading", { level: 2, name: "No articles found" })).toBeVisible();

  await search.fill("");
  await expect(page).toHaveURL(/\/help$/);
});

test("the not-found page's search lands on filtered help results", async ({ browser }) => {
  // Signed out, unknown paths go to sign-in; the not-found page is for signed-in people.
  const { page } = await newUser(browser, "notfound");
  await page.goto("/this-page-does-not-exist-e2e");
  const box = page.getByRole("searchbox").first();
  await box.fill("credits");
  await box.press("Enter");
  await page.waitForURL(/\/help\?q=credits/);
  await expect(page.getByRole("searchbox")).toHaveValue("credits");
});
