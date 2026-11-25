import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { ask, newUser, subscribe } from "./helpers";

/**
 * Journey 6 (guide 10.4): export a response as PDF and Word (and Markdown).
 * Word/PDF follow the workspace owner's plan (Standard here); the files are
 * checked by their signatures, not just their names.
 */
async function download(page: Page, item: string) {
  await page.locator("main").getByRole("button", { name: "Export" }).first().click();
  const pending = page.waitForEvent("download");
  await page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: item }).click();
  const file = await pending;
  const bytes = fs.readFileSync((await file.path())!);
  return { name: file.suggestedFilename(), bytes };
}

test("export a response as PDF, Word and Markdown", async ({ browser }) => {
  const user = await newUser(browser, "export");
  await subscribe(user.context.request, user.email, "STANDARD");
  await user.page.reload();
  await ask(user.page, "Write a one-page brief");

  const pdf = await download(user.page, "PDF (.pdf)");
  expect(pdf.name).toMatch(/\.pdf$/);
  expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");

  const docx = await download(user.page, "Word (.docx)");
  expect(docx.name).toMatch(/\.docx$/);
  expect(docx.bytes.subarray(0, 2).toString()).toBe("PK"); // a ZIP container

  const md = await download(user.page, "Markdown (.md)");
  expect(md.name).toMatch(/\.md$/);
  expect(md.bytes.toString()).toContain("A closing sentence ends the answer.");
});
