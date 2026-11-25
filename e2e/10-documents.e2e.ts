import fs from "node:fs";
import path from "node:path";
import { expect, test, ask, composer, newUser, subscribe } from "./helpers";

/**
 * Journey 10 (after the interlude): add a DOCX to the workspace → Ask Klecx
 * to review → accept the fix → Save → the saved text has it; then generate a
 * Word document → open it → edit → download. The fake model flags "teh"
 * (in the fixture) and creates a document on `[[fake:docx]]`.
 */
test("review an uploaded DOCX and accept a fix; generate, edit and download a Word document", async ({ browser }) => {
  test.setTimeout(150_000);
  const user = await newUser(browser, "docs");
  await subscribe(user.context.request, user.email, "STANDARD"); // Word downloads
  const { page } = user;
  await page.reload();
  await ask(page, "Start a documents workspace");

  // Add the DOCX to the workspace as a document.
  await page.getByRole("button", { name: "Attach files" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Add to workspace as a document", { exact: true }).click();
  await (await chooser).setFiles(path.join(__dirname, "fixtures", "handbook.docx"));
  const doc = page.getByRole("article").filter({ hasText: "handbook.docx" });
  await expect(doc.getByText("Welcome to teh team.", { exact: false })).toBeVisible();

  // Review: one fix for the typo.
  await doc.getByRole("button", { name: "Ask Klecx to review" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start review" }).click();
  await expect(doc.getByRole("button", { name: "Accept all fixes (1)" })).toBeVisible();

  // Accept changes the unsaved draft; Save records it as a new revision.
  await doc.getByRole("button", { name: "Accept all fixes (1)" }).click();
  await expect(doc.getByText("Welcome to the team.", { exact: false })).toBeVisible();
  await expect(doc.getByText("Unsaved changes (1)")).toBeVisible();
  await doc.getByRole("button", { name: "Save", exact: true }).click();
  await expect(doc.getByText(/Unsaved changes/)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("article").filter({ hasText: "handbook.docx" }).getByText("Welcome to the team.", { exact: false })).toBeVisible();

  // Generate a Word document from a prompt.
  await composer(page).fill("Write an onboarding guide as a Word document [[fake:docx]]");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("The document is ready.")).toBeVisible();
  const generated = page.getByText("Fake test document").first();
  await expect(generated).toBeVisible();

  // Open it in its column, edit, save, download the edited version.
  await page.getByRole("button", { name: "Open document Fake test document" }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Fake test document", level: 2 })).toBeVisible();
  await page.getByRole("tab", { name: "Edit" }).click();
  const editor = page.getByRole("tabpanel", { name: "Edit" }).getByRole("textbox").first();
  await editor.fill("# Fake test document\n\nAn edited first paragraph.");
  await page.getByRole("button", { name: /^Save/ }).last().click();
  await expect(page.getByRole("button", { name: "Revision history" })).toContainText("Revision 2");
  const pending = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download" }).last().click();
  const file = await pending;
  expect(file.suggestedFilename()).toMatch(/\.docx$/);
  expect(fs.readFileSync((await file.path())!).subarray(0, 2).toString()).toBe("PK");
});
