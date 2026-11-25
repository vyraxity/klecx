import { expect, test, PASSWORD, ask, dismissCookieNotice, uniqueEmail, uniqueUsername, untilAnswered, waitForEmail } from "./helpers";

/**
 * Journey 1 (guide 10.4): register → verify (the email from the test inbox)
 * → claim a username → first prompt creates the workspace → streamed answer
 * → regenerate → edit → switch versions.
 */
test("register, verify, claim a username, get an answer, regenerate, edit, switch versions @mobile", async ({ page, request }) => {
  const email = uniqueEmail("first");
  const password = PASSWORD;

  await page.goto("/auth/register");
  await dismissCookieNotice(page);
  await page.getByPlaceholder("name@example.com").fill(email);
  await page.getByPlaceholder("Your full name").fill("Ada Tester");
  await page.getByPlaceholder("••••••••••••").fill(password);
  await page.getByPlaceholder("Confirm your password").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL(/\/auth\/registered/);

  const mail = await waitForEmail(request, email, "verify-email");
  expect(mail.subject).toContain("Verify");
  await page.goto(mail.links.find((l) => l.includes("/verify-email"))!);
  await page.waitForURL(/\/workspaces/);

  // Claim a username (asked once, right after sign-up).
  const username = uniqueUsername("ada");
  const dialog = page.getByRole("dialog", { name: "Choose your username" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Username" }).fill(username);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Confirm & Claim" }).click();
  await expect(page.getByText(`Username claimed: @${username}`)).toBeVisible();

  // The first prompt creates the workspace; the answer streams in.
  await ask(page, "Explain photosynthesis");
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}/);
  await expect(page.getByText('Here is a test answer about "Explain photosynthesis".')).toBeVisible();

  // Regenerate: a second version, with navigation between them.
  await untilAnswered(page, () => page.getByRole("button", { name: "Regenerate" }).click());
  const versions = page.getByRole("group", { name: /Version \d of \d/ });
  await expect(versions).toHaveAccessibleName("Version 2 of 2");

  // Edit: the edit is saved separately, the AI original is kept.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit response content..." });
  await editor.fill("My own edited answer about photosynthesis.");
  await page.getByRole("button", { name: "Save as edit" }).click();
  await expect(page.getByText("My own edited answer about photosynthesis.")).toBeVisible();

  // Switch versions: version 1 shows the original answer; version 2 the edit.
  await versions.getByRole("button", { name: "Previous version" }).click();
  await expect(versions).toHaveAccessibleName("Version 1 of 2");
  await expect(page.getByText("My own edited answer about photosynthesis.")).toHaveCount(0);
  await expect(page.getByText("A closing sentence ends the answer.").last()).toBeVisible();
  await versions.getByRole("button", { name: "Next version" }).click();
  await expect(versions).toHaveAccessibleName("Version 2 of 2");
  await expect(page.getByText("My own edited answer about photosynthesis.")).toBeVisible();
});
