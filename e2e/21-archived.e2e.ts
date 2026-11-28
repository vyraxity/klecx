import type { Page } from "@playwright/test";
import { test, expect, newUser, ask } from "./helpers";

/**
 * Pre-10.6 fix PR 8 (owner, 2026-11-28): an archived workspace can be found
 * and taken out of the archive from Settings → Deleted & archived, Archived
 * tab; the archive toast says where it went and offers Undo.
 */
async function archiveOpenWorkspace(page: Page) {
  await page.getByTestId("topbar").getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByText("Find it in Settings → Deleted & archived.")).toBeVisible();
  await page.waitForURL(/\/workspaces$/);
}

test("archive a workspace, undo it, archive it again and unarchive it from Settings", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await newUser(browser, "archived");
  await ask(page, "Plan a picnic");
  const workspaceUrl = new URL(page.url()).pathname;
  const title = (await page.getByTestId("topbar").getByRole("button").filter({ hasText: /\w/ }).first().textContent())?.trim() ?? "";
  // The sidebar is an <aside> (role "complementary").
  const sidebar = page.getByRole("complementary", { name: "Sidebar navigation" });

  // Undo from the toast.
  await archiveOpenWorkspace(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Workspace taken out of the archive")).toBeVisible();
  await page.waitForURL((url) => url.pathname === workspaceUrl);

  // Archive again: it leaves the sidebar and is listed on the Archived tab.
  await archiveOpenWorkspace(page);
  await expect(sidebar.getByRole("link", { name: title })).toHaveCount(0);

  // The Deleted tab is the default; switching tabs keeps the address in step.
  await page.goto("/settings/deleted");
  await expect(page.getByRole("heading", { level: 1, name: "Deleted & archived" })).toBeVisible();
  await page.getByRole("tab", { name: "Archived" }).click();
  await expect(page).toHaveURL(/\/settings\/deleted\?tab=archived$/);

  // A link opens the Archived tab directly.
  await page.goto("/settings/deleted?tab=archived");
  await expect(page.getByRole("tab", { name: "Archived" })).toHaveAttribute("aria-selected", "true");
  const list = page.getByTestId("archived-workspaces");
  await expect(list).toContainText(title);
  await list.getByRole("button", { name: `Unarchive ${title}` }).click();
  await expect(page.getByText(`“${title}” is back in your sidebar`)).toBeVisible();
  await expect(list).toContainText("No archived workspaces.");
  await expect(sidebar.getByRole("link", { name: title })).toHaveCount(1);
});
