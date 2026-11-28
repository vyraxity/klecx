import type { Page } from "@playwright/test";
import { test, expect, newUser, ask } from "./helpers";

/**
 * Pre-10.6 fix PR 6 (owner, 2026-11-27): a deleted workspace can be brought
 * back with Undo right away, or for 30 days from Settings → Deleted & archived
 * (also reached from the sidebar's account menu).
 */
async function deleteOpenWorkspace(page: Page) {
  await page.getByTestId("topbar").getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(dialog).toContainText("Deleted & archived");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await page.waitForURL(/\/workspaces$/);
}

test("delete a workspace, undo it, delete it again and restore it from Deleted & archived", async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await newUser(browser, "deleted");
  await ask(page, "Plan a garden");
  const workspaceUrl = new URL(page.url()).pathname;
  const title = (await page.getByTestId("topbar").getByRole("button").filter({ hasText: /\w/ }).first().textContent())?.trim() ?? "";
  // The sidebar is an <aside> (role "complementary").
  const sidebar = page.getByRole("complementary", { name: "Sidebar navigation" });

  // Undo from the toast.
  await deleteOpenWorkspace(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForURL((url) => url.pathname === workspaceUrl);
  await expect(page.getByText("Workspace restored")).toBeVisible();

  // Delete again; restore from Settings → Deleted & archived (Deleted tab).
  await deleteOpenWorkspace(page);
  await expect(sidebar.getByRole("link", { name: title })).toHaveCount(0);
  await page.goto("/settings/deleted");
  const list = page.getByTestId("deleted-workspaces");
  await expect(list).toContainText(title);
  await expect(list).toContainText("29 days left");
  await list.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByText(`“${title}” restored`)).toBeVisible();
  await expect(list).toContainText("No deleted workspaces.");
  await expect(sidebar.getByRole("link", { name: title })).toHaveCount(1);
  await page.goto(workspaceUrl);
  await expect(page.getByTestId("topbar")).toContainText(title);
});

test("the account menu opens Deleted & archived", async ({ browser }) => {
  const { page } = await newUser(browser, "deletedmenu");
  await page.getByRole("button", { name: /Deletedmenu Tester/ }).first().click();
  await page.getByRole("menuitem", { name: "Deleted & archived" }).click();
  await page.waitForURL(/\/settings\/deleted/);
  await expect(page.getByTestId("deleted-workspaces")).toContainText("No deleted workspaces.");
  await expect(page.getByTestId("deleted-projects")).toContainText("No deleted projects.");
});
