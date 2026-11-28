import { test, expect, newUser, waitForEmail, PASSWORD } from "./helpers";

/**
 * Pre-10.6 fix PR 5 (owner, 2026-11-27): an account without a password (as
 * after Google/GitHub sign-in) adds one in Settings → Security with a 6-digit
 * code emailed to it, without leaving the page; then signs in with it.
 */
const NEW_PASSWORD = "Another-long-passphrase-42";

test("add a password from Settings with an emailed code, then sign in with it", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, email, context } = await newUser(browser, "setpw");
  const removed = await context.request.post("/api/test/remove-password", { data: { email } });
  expect(removed.ok()).toBeTruthy();

  await page.goto("/settings/security");
  const card = page.getByTestId("settings-password");
  await card.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await card.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await card.getByRole("button", { name: "Email me a code" }).click();

  const mail = await waitForEmail(context.request, email, "password-set-code");
  const code = mail.text.match(/\b(\d{6})\b/)?.[1];
  expect(code, "code in the email").toBeTruthy();

  // A wrong code first: told so, nothing changes.
  const codeBox = card.getByLabel("Code from the email");
  await codeBox.fill(code === "000000" ? "111111" : "000000");
  await card.getByRole("button", { name: "Add password" }).click();
  await expect(card.getByRole("alert")).toContainText("That code isn't right");

  await codeBox.fill(code!);
  await card.getByRole("button", { name: "Add password" }).click();
  // The card now offers to change the password (it has one).
  await expect(page.getByTestId("settings-password").getByLabel("Current password")).toBeVisible();
  await waitForEmail(context.request, email, "password-changed");

  // Sign in with the new password in a fresh browser.
  const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const signIn = await fresh.request.post("/api/auth/sign-in/email", {
    data: { email, password: NEW_PASSWORD },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(signIn.ok(), `sign-in ${signIn.status()}`).toBeTruthy();
  const old = await fresh.request.post("/api/auth/sign-in/email", {
    data: { email, password: PASSWORD },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(old.ok()).toBeFalsy();
  await fresh.close();
});

test("a password-reset link opens while signed in", async ({ browser }) => {
  const { page } = await newUser(browser, "resetsignedin");
  await page.goto("/auth/reset-password?token=not-a-real-token");
  await expect(page).toHaveURL(/\/auth\/reset-password/);
});
