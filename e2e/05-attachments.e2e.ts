import { test, expect } from "@playwright/test";
import path from "node:path";
import { composer, newUser } from "./helpers";

/**
 * Journey 5 (guide 10.4): attach a PDF and an image → send → the answer used
 * them (the fake model reports how many files reached it). Storage is the
 * in-memory mock in test mode (no Cloudinary).
 */
test("attach a PDF and an image; the answer receives both", async ({ browser }) => {
  const { page } = await newUser(browser, "files");
  const fixtures = path.join(__dirname, "fixtures");

  // The first prompt creates the workspace; files attach to the next one.
  await composer(page).fill("Start a workspace for my files");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("A closing sentence ends the answer.")).toBeVisible();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]{36}/);

  await page.getByRole("button", { name: "Attach files" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Attach to message", { exact: true }).click();
  await (await chooser).setFiles([path.join(fixtures, "sample.pdf"), path.join(fixtures, "sample.png")]);
  const region = page.getByRole("region", { name: "Composer" });
  await expect(region.getByText("sample.pdf")).toBeVisible();
  await expect(region.getByText("sample.png")).toBeVisible();
  // Wait until both uploads are ready (Send is enabled with text once they are).
  await composer(page).fill("Summarise the attached files");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("I looked at 2 attached files.")).toBeVisible();
  // The prompt shows its attachments.
  await expect(page.locator("main").getByText("sample.pdf").first()).toBeVisible();
});
