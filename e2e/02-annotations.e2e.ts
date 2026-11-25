import { test, expect, type Page } from "@playwright/test";
import { ask, newUser, selectText } from "./helpers";

/**
 * Journey 2 (guide 10.4, as changed after the interlude): select → Comment
 * with @klecx (a note Klecx remembers) → Ask now → Ask inside the answer (L2,
 * L3) → Back / Main → queue questions on two levels → Ask all → promote from
 * L2 to the timeline and to a new workspace. (A Comment with @user needs a
 * collaborator: journey 3.)
 */

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Annotation actions" });
const columns = (page: Page) => page.locator('[data-testid^="thread-column-"]');

async function askNow(page: Page, question: string) {
  await toolbar(page).getByRole("button", { name: "Ask", exact: true }).click();
  await toolbar(page).getByRole("textbox", { name: "Ask question text" }).fill(question);
  await toolbar(page).getByRole("button", { name: /Ask now/ }).click();
}

async function queue(page: Page, question: string) {
  await toolbar(page).getByRole("button", { name: "Ask", exact: true }).click();
  await toolbar(page).getByRole("textbox", { name: "Ask question text" }).fill(question);
  await toolbar(page).getByRole("button", { name: /Add to queue/ }).click();
  await expect(toolbar(page)).toContainText("Question added to queue");
  await page.keyboard.press("Escape");
}

test("comment with @klecx, ask three levels deep, queue on two levels, ask all, promote", async ({ browser }) => {
  test.setTimeout(150_000);
  const { page, context } = await newUser(browser, "annot");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await ask(page, "Explain clouds");
  const main = page.locator("main");

  // Comment with @klecx: becomes a workspace note.
  await selectText(page, main.getByText("A closing sentence ends the answer.").first());
  await toolbar(page).getByRole("button", { name: "Comment" }).click();
  const comment = toolbar(page).getByRole("textbox", { name: "Comment text" });
  await comment.pressSequentially("@kle");
  await expect(page.getByRole("listbox", { name: "People you can mention" }).getByRole("option", { name: /Klecx/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await comment.pressSequentially(" always use metric units");
  await toolbar(page).getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Klecx will remember this")).toBeVisible();
  await expect(page.getByRole("button", { name: "Klecx notes (1)" })).toBeVisible();

  // Queue a question on the main answer (asked later, with "Ask all").
  await selectText(page, main.getByText("Point two: a supporting detail.").first());
  await queue(page, "Queued on the main answer?");

  // Ask now → Level 1 opens as a column next to the conversation.
  await selectText(page, main.getByText("Point one: the main idea.").first());
  await askNow(page, "Why is this the main idea?");
  await expect(page).toHaveURL(/thread=a(%3A|:)/);
  const l1 = columns(page).last();
  await expect(l1.getByText("Level 1")).toBeVisible();
  await expect(l1.getByText("A closing sentence ends the answer.")).toBeVisible();

  // A second queued question, on the Level 1 answer.
  await selectText(page, l1.getByText("Point one: the main idea.", { exact: true }));
  await queue(page, "Queued on a thread answer?");

  // Ask inside the answer: Level 2, then Level 3.
  await selectText(page, l1.getByText("Point two: a supporting detail.", { exact: true }));
  await askNow(page, "And the supporting detail?");
  await expect(columns(page).last().getByText("Level 2")).toBeVisible();
  const l2 = columns(page).last();
  await expect(l2.getByText("A closing sentence ends the answer.")).toBeVisible();
  await selectText(page, l2.getByText("Point one: the main idea.", { exact: true }));
  await askNow(page, "One level deeper?");
  await expect(columns(page).last().getByText("Level 3")).toBeVisible();
  await expect(columns(page).last().getByText("A closing sentence ends the answer.")).toBeVisible();

  // Back goes up one level, to Level 2.
  await columns(page).last().getByRole("button", { name: "Back" }).click();
  const back = columns(page).last();
  await expect(back.getByText("Level 2")).toBeVisible();

  // Promote the Level 2 answer: to the timeline, then to a new workspace.
  const responsesBefore = await main.getByRole("button", { name: "Regenerate" }).count();
  await back.getByRole("button", { name: "Add to timeline" }).click();
  await expect(main.getByRole("button", { name: "Regenerate" })).toHaveCount(responsesBefore + 1);
  await back.getByRole("button", { name: "New workspace" }).click();
  const standalone = page.locator('[data-testid^="promote-project-standalone-"]');
  if (await standalone.isVisible().catch(() => false)) await standalone.click();
  await expect(back.locator('[data-testid^="chip-open-workspace-"]')).toBeVisible();

  // Main closes the threads.
  await back.getByRole("button", { name: "Main", exact: true }).click();
  await expect(columns(page)).toHaveCount(0);

  // Ask all: one column with both queued questions and their answers.
  await page.getByRole("button", { name: "Questions (2)" }).click();
  await page.getByRole("button", { name: "Ask all (2)" }).click();
  await expect(page).toHaveURL(/thread=b(%3A|:)/);
  await expect(page.getByText("2 of 2 answered")).toBeVisible();
  await expect(page.getByText(/Fake answer to "Queued on the main answer\?"/)).toBeVisible();
  await expect(page.getByText(/Fake answer to "Queued on a thread answer\?"/)).toBeVisible();
  void context;
});
