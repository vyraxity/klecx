import { test, expect, newUser, subscribe, ask, composer, typeInComposer } from "./helpers";

/**
 * Pre-10.6 fix PR 1 (owner, 2026-11-27): new messages start on Standard
 * Reasoning on a paid plan (Fast & Efficient on Free), the default can be
 * changed in Settings → Language & AI, the composer warns before a message
 * the balance can't cover, and a refused message says what it needed.
 */
const modelTrigger = (page: import("@playwright/test").Page) => page.getByTestId("composer-model-trigger");

async function setCredits(request: import("@playwright/test").APIRequestContext, email: string, balance: number) {
  const res = await request.post("/api/test/set-credits", { data: { email, balance } });
  expect(res.ok(), `set-credits ${res.status()} ${await res.text()}`).toBeTruthy();
}

test("default model follows the plan and the setting; low credits are explained", async ({ browser }) => {
  test.setTimeout(150_000);
  const { page, email, context } = await newUser(browser, "defaultmodel");
  // The "credits low" upgrade offer (once per period) can open over the page
  // at a low balance: close it whenever it gets in the way.
  await page.addLocatorHandler(page.getByRole("dialog", { name: /^Upgrade to/ }), async () => {
    await page.keyboard.press("Escape");
  });

  // Free: Fast & Efficient.
  await expect(modelTrigger(page)).toContainText("Fast & Efficient");

  // A paid plan: Standard Reasoning by default (Automatic).
  await subscribe(context.request, email, "LITE");
  await page.reload();
  await expect(modelTrigger(page)).toContainText("Standard Reasoning");
  await ask(page, "Plan a trip");
  const workspaceUrl = page.url();

  // Too few credits for Standard Reasoning: warned, Send blocked, one click to switch.
  await setCredits(context.request, email, 10);
  await page.goto(workspaceUrl);
  const warning = page.getByTestId("low-credits-warning");
  await expect(warning).toContainText("This model needs about 16 credits per message, and you have 10.");
  await composer(page).fill("Shorter answer please");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await warning.getByRole("button", { name: "Use Fast & Efficient" }).click();
  await expect(warning).toHaveCount(0);
  await expect(modelTrigger(page)).toContainText("Fast & Efficient");
  await ask(page, "Shorter answer please");

  // Enough for the shortest Standard Reasoning message, not for a long one:
  // the server refuses it and says what it needed.
  await setCredits(context.request, email, 17);
  await page.goto(workspaceUrl);
  await expect(modelTrigger(page)).toContainText("Standard Reasoning");
  await typeInComposer(page, composer(page), `Summarise this: ${"lorem ipsum dolor sit amet ".repeat(320)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /This message needs about \d+ credits, and you have 17\./ })).toBeVisible();

  // The default can be changed in Settings → Language & AI.
  await setCredits(context.request, email, 500);
  await page.goto("/settings/language");
  const select = page.getByTestId("settings-default-model-select");
  await expect(select).toHaveValue("");
  await select.selectOption("text-economy");
  await expect(page.getByText("Default model updated")).toBeVisible();
  await page.goto("/workspaces");
  await expect(modelTrigger(page)).toContainText("Fast & Efficient");
});
