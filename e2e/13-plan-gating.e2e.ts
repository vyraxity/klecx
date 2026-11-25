import { E2E_BASE_URL } from "./env.mjs";
import { expect, test, ask, newUser, openShare } from "./helpers";

/**
 * Journey 13 (after the interlude): a Free person sees plan-gated controls
 * disabled with an explanation, and the server refuses the same actions
 * when the request is forged (rule 1: the server decides).
 */
test("Free plan: gated controls are disabled with a reason, and forged requests are refused", async ({ browser }) => {
  const { page, context } = await newUser(browser, "gated");
  await ask(page, "A Free plan workspace");
  const workspaceId = page.url().match(/\/workspaces\/([0-9a-f-]{36})/)![1]!;

  // The Standard model is disabled in the composer's model menu, with the reason.
  await page.getByTestId("composer-model-trigger").click();
  const standard = page.getByRole("dialog").getByRole("button", { name: /Standard Reasoning/ });
  await expect(standard).toBeVisible();
  await expect(standard).toBeDisabled();
  await page.getByRole("dialog").getByText(/Standard Reasoning/).hover();
  await expect(page.getByRole("tooltip").first()).toBeVisible();
  await page.keyboard.press("Escape");

  // Inviting is gated too (Free: no collaborators).
  const share = await openShare(page);
  await expect(share).toBeVisible();
  await expect(share.getByRole("button", { name: "Invite" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // Forged requests: the server re-checks the plan.
  const headers = { origin: E2E_BASE_URL };
  const gen = await context.request.post(`/api/v1/workspaces/${workspaceId}/generations`, {
    headers,
    data: { idempotencyKey: `forged-${Date.now()}`, prompt: "Use the better model", modelKey: "text-standard" },
  });
  expect(gen.status()).toBe(403);
  const invite = await context.request.post(`/api/v1/workspaces/${workspaceId}/invitations`, {
    headers,
    data: { emailOrUsername: "someone@example.com", role: "EDITOR" },
  });
  expect([402, 403]).toContain(invite.status());
});
