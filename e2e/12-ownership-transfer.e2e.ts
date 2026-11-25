import { expect, test, ask, inviteAndAccept, newUser, subscribe } from "./helpers";

/**
 * Journey 12 (after the interlude): an ownership transfer is refused while it
 * doesn't fit the recipient's plan (Free: no collaborators, and the previous
 * owner would stay as one), then sent once it fits; the recipient accepts and
 * becomes the owner.
 */
test("transfer ownership: blocked by the recipient's plan, then requested and accepted", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await newUser(browser, "giver", { name: "Gil Giver" });
  const recipient = await newUser(browser, "taker", { name: "Tara Taker" });
  await subscribe(owner.context.request, owner.email, "STANDARD");
  await owner.page.reload();
  await ask(owner.page, "A workspace to hand over");
  const workspaceUrl = owner.page.url().split("?")[0]!;
  await inviteAndAccept(owner, recipient);

  const openTransfer = async () => {
    await owner.page.goto(workspaceUrl);
    await owner.page.getByRole("banner").getByRole("button", { name: "Share" }).click();
    const share = owner.page.getByRole("dialog", { name: /^Share/ });
    await share.getByRole("button", { name: "Transfer ownership" }).click();
    return owner.page.getByRole("dialog", { name: "Transfer ownership" });
  };

  // Free recipient: they'd have 1 collaborator (the owner stays as admin), their limit is 0.
  let dialog = await openTransfer();
  await expect(dialog.getByText(/The recipient's plan allows 0 collaborators/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send request" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // On Standard it fits; the request is sent with the confirmation word.
  await subscribe(recipient.context.request, recipient.email, "STANDARD");
  dialog = await openTransfer();
  await expect(dialog.getByText(/Fits the recipient's plan/)).toBeVisible();
  await dialog.getByPlaceholder("TRANSFER").fill("TRANSFER");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(owner.page.getByText(/Request sent/)).toBeVisible();

  // The recipient accepts from the workspace's Share dialog.
  await recipient.page.goto(workspaceUrl);
  await recipient.page.getByRole("banner").getByRole("button", { name: "Share" }).click();
  const share = recipient.page.getByRole("dialog", { name: /^Share/ });
  await expect(share.getByText(/wants to transfer ownership/)).toBeVisible();
  await share.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(recipient.page.getByText("You're now the owner.")).toBeVisible();

  // The new owner shows as Owner in People.
  await recipient.page.reload();
  await recipient.page.getByRole("banner").getByRole("button", { name: "Share" }).click();
  const people = recipient.page.getByRole("dialog", { name: /^Share/ }).getByRole("tabpanel");
  await expect(people.getByText(/Tara Taker\s*You\s*Owner/)).toBeVisible();
});
