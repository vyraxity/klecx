import { test, expect, type Page } from "@playwright/test";
import { newUser } from "./helpers";

/**
 * Journey 9 (guide 10.4): the app's language, the language Klecx answers in
 * (Settings) and a request in the prompt are three separate things. The fake
 * model reports which answer language its instructions asked for.
 */
async function askIn(page: Page, label: string, prompt: string, expected: string) {
  const box = page.getByRole("textbox", { name: label });
  const before = await page.getByText(expected).count();
  await box.fill(prompt);
  await page.getByRole("region").filter({ has: box }).getByRole("button").last().click();
  // One more answer saying it, so an earlier answer can't satisfy the check.
  await expect(page.getByText(expected)).toHaveCount(before + 1);
}

test("app language, answer language and a per-prompt request are independent", async ({ browser }) => {
  const { page } = await newUser(browser, "lang");

  // Klecx answers in Spanish (Settings), while the app stays in English for now.
  await page.goto("/settings/language");
  await page.getByRole("combobox", { name: "Language Klecx answers in" }).selectOption({ label: "Español (ES)" });
  await expect(page.getByRole("combobox", { name: "Language Klecx answers in" })).toHaveValue(/es/i);

  // The app in French: menus change, the answer language doesn't.
  await page.getByRole("region", { name: "App language" }).getByRole("combobox").selectOption({ label: "Français" });
  await expect(page.getByRole("heading", { name: "Language & AI" })).toHaveCount(0);
  await page.goto("/workspaces");
  const frLabel = "Comment Klecx peut-il vous aider aujourd'hui ?";
  await expect(page.getByRole("textbox", { name: frLabel })).toBeVisible();
  await askIn(page, frLabel, "Explain rain", "(Answering in Spanish.)");

  // A request in the prompt wins for that answer only.
  await askIn(page, frLabel, "Explain snow, answer in German", "(Answering in German, as asked.)");
  await askIn(page, frLabel, "Explain hail", "(Answering in Spanish.)");
});
