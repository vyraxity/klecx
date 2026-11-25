import { E2E_BASE_URL } from "./env.mjs";
import { expect, test, PASSWORD, dismissCookieNotice, newUser } from "./helpers";

/**
 * Journey 8 (guide 10.4): sign in on two browsers → revoke one from
 * Settings → Sessions & devices → that browser is signed out.
 */
test("revoke another session and it is signed out", async ({ browser }) => {
  const user = await newUser(browser, "sessions");

  // A second device signs in through the login form.
  const other = await browser.newContext({ baseURL: E2E_BASE_URL, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" });
  const second = await other.newPage();
  await second.goto("/auth/login");
  await dismissCookieNotice(second);
  await second.getByPlaceholder("name@example.com").fill(user.email);
  await second.getByPlaceholder("••••••••••••").fill(PASSWORD);
  await second.getByRole("button", { name: "Sign In" }).click();
  await second.waitForURL(/\/workspaces/);

  // The first device sees both and revokes the other one.
  await user.page.goto("/settings/sessions");
  const main = user.page.locator("main");
  await expect(main.getByText("This device")).toBeVisible();
  await expect(main.getByText(/Safari/).first()).toBeVisible();
  await main.getByRole("button", { name: /Revoke|Sign out/ }).first().click();
  const confirm = user.page.getByRole("alertdialog");
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button", { name: /Revoke|Sign out/ }).last().click();
  await expect(main.getByText(/Safari/)).toHaveCount(0);

  // The revoked browser is signed out: the API refuses it and the app sends it to sign in.
  const me = await other.request.get("/api/v1/me");
  expect(me.status()).toBe(401);
  await second.goto("/workspaces");
  await second.waitForURL(/\/auth\/login/);

  // The first device still works.
  expect((await user.context.request.get("/api/v1/me")).ok()).toBeTruthy();
  await other.close();
});
