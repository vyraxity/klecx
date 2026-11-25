import { expect, test, ask, credits, newUser, selectText, subscribe, waitForEmail, openShare } from "./helpers";

/**
 * Journey 3 (guide 10.4): invite a collaborator → they accept and generate →
 * the owner's credits drop (the workspace owner pays) → the activity shows
 * who did it. Also the Comment with @user from journey 2: the mention
 * notifies the owner.
 */
test("invite a collaborator who generates on the owner's credits; activity and @mention", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await newUser(browser, "owner", { name: "Olu Owner" });
  const member = await newUser(browser, "member", { name: "Mia Member" });
  // Collaborators need Standard or Pro (Free and Lite: 0).
  await subscribe(owner.context.request, owner.email, "STANDARD");

  await owner.page.reload();
  await ask(owner.page, "Plan a team offsite");
  const workspaceUrl = owner.page.url();

  // Invite by email from the Share dialog.
  const share = await openShare(owner.page);
  await share.getByRole("textbox", { name: "Invite people by email or @username" }).fill(member.email);
  await share.getByRole("button", { name: "Invite" }).click();
  await expect(share.getByRole("tab", { name: "Invitations" })).toBeVisible();
  await share.getByRole("button", { name: "Close dialog" }).click();

  // The member opens the emailed invitation and accepts it.
  const invite = await waitForEmail(member.context.request, member.email, "invitation");
  const link = invite.links.find((l) => l.includes("/invite/"));
  expect(link, "invitation link").toBeTruthy();
  await member.page.goto(link!);
  await member.page.getByRole("button", { name: /Accept/ }).click();
  await member.page.waitForURL(/\/workspaces\/[0-9a-f-]{36}/);
  expect(member.page.url().split("?")[0]).toBe(workspaceUrl.split("?")[0]);

  // The member generates: the owner pays, the member's own credits don't move.
  const ownerBefore = await credits(owner.context.request);
  const memberBefore = await credits(member.context.request);
  await ask(member.page, "Suggest three activities");
  await expect.poll(() => credits(owner.context.request)).toBeLessThan(ownerBefore);
  expect(await credits(member.context.request)).toBe(memberBefore);

  // The member mentions the owner in a comment; the owner is notified.
  await selectText(member.page, member.page.locator("main").getByText("A closing sentence ends the answer.").last());
  await member.page.getByRole("toolbar", { name: "Annotation actions" }).getByRole("button", { name: "Comment" }).click();
  const box = member.page.getByRole("textbox", { name: "Comment text" });
  await box.pressSequentially(`@${owner.username.slice(0, 5)}`);
  await member.page.getByRole("listbox", { name: "People you can mention" }).getByRole("option", { name: /Olu Owner/ }).click();
  await box.pressSequentially(" can you check this?");
  await member.page.getByRole("toolbar", { name: "Annotation actions" }).getByRole("button", { name: "Save" }).click();
  await waitForEmail(owner.context.request, owner.email, "mentioned");

  // The owner sees who did what in the activity.
  await owner.page.goto(workspaceUrl);
  const dialog = await openShare(owner.page);
  await dialog.getByRole("tab", { name: "Activity" }).click();
  await expect(dialog.getByRole("tabpanel").getByText("Mia Member").first()).toBeVisible();
});
