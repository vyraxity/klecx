import { test, expect } from "@playwright/test";
import { credits, newUser } from "./helpers";

/**
 * Journey 7 (guide 10.4): Free → Lite through Plan & billing and the
 * (simulated) hosted checkout → cancel at the period end → keep the plan
 * (resume) → a failed renewal shows the payment-issue banner.
 *
 * Creem's hosted page can't be automated, so in test mode the checkout URL
 * is a local page that sends the same **signed** webhooks Creem would
 * (`server/testing/e2e.ts`); the real signature check and state machine run.
 */
test("upgrade to Lite, cancel, keep the plan, payment issue banner @mobile", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, context, email } = await newUser(browser, "billing");
  await page.goto("/settings/billing");
  await expect(page.getByRole("region", { name: "Free" })).toBeVisible();

  // Choose Lite; the consent box is required before Subscribe.
  await page.getByRole("button", { name: "Upgrade" }).last().click();
  const dialog = page.getByRole("dialog", { name: "Choose a plan" });
  const lite = dialog.getByRole("listitem").filter({ hasText: "Lite" });
  await expect(lite.getByRole("button", { name: "Subscribe" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await lite.getByRole("button", { name: "Subscribe" }).click();

  // The fake checkout "pays" and returns to Klecx, which waits for the webhook.
  await page.waitForURL(/\/settings\/billing/);
  await expect(page.getByRole("region", { name: "Lite" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => credits(context.request)).toBe(800);

  // Cancel at the end of the period, confirmed with its date.
  await page.getByRole("button", { name: /^Cancel/ }).first().click();
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await confirm.getByRole("button", { name: /Cancel/ }).filter({ hasNotText: /Keep|Back|Close/ }).last().click();
  await expect(page.getByRole("button", { name: "Keep my plan" })).toBeVisible();

  // Keep the plan (resume).
  await page.getByRole("button", { name: "Keep my plan" }).click();
  await expect(page.getByRole("button", { name: "Keep my plan" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Lite" })).toBeVisible();

  // A renewal fails: Creem reports past_due → the payment-issue banner.
  const res = await context.request.post("/api/test/subscription-event", { data: { email, type: "subscription.past_due" } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: /payment/i }).first()).toBeVisible();
});
