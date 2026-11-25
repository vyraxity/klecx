import { test, expect, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./env.mjs";
import { ask, newUser, waitForEmail } from "./helpers";

/**
 * Journey 4 (guide 10.4): share the whole workspace and a single response →
 * open each link signed out → revoke → the link answers 404.
 */

async function createLink(page: Page, openFrom: "workspace" | "response"): Promise<void> {
  if (openFrom === "workspace") {
    await page.getByRole("banner").getByRole("button", { name: "Share" }).click();
    await page.getByRole("dialog").getByRole("tab", { name: "Public Link" }).click();
  } else {
    await page.locator("main").getByRole("button", { name: "Share" }).first().click();
  }
  const panel = page.getByRole("dialog").getByRole("tabpanel", { name: "Public Link" });
  await expect(panel.getByRole("combobox").first()).toHaveText(openFrom === "workspace" ? "Entire workspace" : "This response only");
  await panel.getByRole("button", { name: "Create public link" }).click();
  await expect(panel.getByText(/\d+ active/)).not.toHaveText("0 active");
}

test("share a workspace and one response, open them signed out, revoke → 404", async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await newUser(browser, "sharer");
  await ask(owner.page, "Write a short welcome note");
  await ask(owner.page, "Write a second note");

  await createLink(owner.page, "workspace");
  const workspaceMail = await waitForEmail(owner.context.request, owner.email, "share-created");
  const workspaceLink = workspaceMail.links.find((l) => l.includes("/s/"))!;
  expect(workspaceLink).toBeTruthy();
  await owner.page.keyboard.press("Escape");

  // A visitor without an account reads the whole workspace.
  const visitor = await browser.newContext({ baseURL: E2E_BASE_URL });
  const guest = await visitor.newPage();
  await guest.goto(workspaceLink);
  await expect(guest.getByText('Here is a test answer about "Write a short welcome note".')).toBeVisible();
  await expect(guest.getByText('Here is a test answer about "Write a second note".')).toBeVisible();

  // A single-response link shows only that response.
  const before = (await owner.context.request.get(`/api/test/emails?to=${encodeURIComponent(owner.email)}`).then((r) => r.json())).data.emails.length;
  await createLink(owner.page, "response");
  await expect
    .poll(async () => (await owner.context.request.get(`/api/test/emails?to=${encodeURIComponent(owner.email)}`).then((r) => r.json())).data.emails.length)
    .toBeGreaterThan(before);
  const responseMail = await waitForEmail(owner.context.request, owner.email, "share-created");
  const responseLink = responseMail.links.find((l) => l.includes("/s/"))!;
  expect(responseLink).not.toBe(workspaceLink);
  await guest.goto(responseLink);
  await expect(guest.getByText(/Here is a test answer about/)).toHaveCount(1);

  // Revoke both: the links stop working.
  const panel = owner.page.getByRole("dialog").getByRole("tabpanel", { name: "Public Link" });
  for (let i = 0; i < 2; i++) {
    await panel.getByRole("button", { name: /Revoke/ }).first().click();
    const confirm = owner.page.getByRole("alertdialog").getByRole("button", { name: /Revoke/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  await expect(panel.getByText("0 active")).toBeVisible();
  for (const link of [workspaceLink, responseLink]) {
    const res = await guest.goto(link);
    expect(res?.status()).toBe(404);
  }
  await visitor.close();
});
