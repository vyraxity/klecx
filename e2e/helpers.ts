import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./env.mjs";

/**
 * Step 10.4: shared steps for the journeys. People are created fresh for
 * every test (unique emails), so tests never depend on each other or on
 * leftover data.
 */

export const PASSWORD = "A-long-e2e-test-passphrase-42";

/** Browser contexts opened by `newUser()` in the current test (closed after it). */
const openContexts = new Set<BrowserContext>();

/**
 * Use this `test` (not Playwright's) in journeys: after every test it closes
 * the people's browser contexts. Left open, their pages keep polling the app
 * and slow down every later test in the worker (seen as random timeouts).
 */
export const test = base.extend<{ closeUsers: void }>({
  closeUsers: [
    async ({}, use) => {
      await use();
      await Promise.all([...openContexts].map((c) => c.close().catch(() => undefined)));
      openContexts.clear();
    },
    { auto: true },
  ],
});
export { expect };
let counter = 0;

export function uniqueEmail(label: string): string {
  return `e2e_${label}_${Date.now().toString(36)}${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 6)}@example.com`;
}

export function uniqueUsername(label: string): string {
  return `${label.replace(/[^a-z]/g, "").slice(0, 8) || "user"}_${Date.now().toString(36).slice(-6)}${(counter++).toString(36)}`;
}

export interface TestEmail {
  to: string;
  template: string;
  subject: string;
  text: string;
  links: string[];
}

/** The test inbox (`/api/test/emails`); waits until an email matching `template` arrives. */
export async function waitForEmail(request: APIRequestContext, to: string, template: string): Promise<TestEmail> {
  let found: TestEmail | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/test/emails?to=${encodeURIComponent(to)}`);
        const emails = ((await res.json()).data?.emails ?? []) as TestEmail[];
        found = [...emails].reverse().find((e) => e.template === template);
        return Boolean(found);
      },
      { message: `email "${template}" to ${to}`, timeout: 20_000 }
    )
    .toBe(true);
  return found!;
}

export interface TestUser {
  email: string;
  name: string;
  username: string;
  context: BrowserContext;
  page: Page;
}

/**
 * A signed-in, verified person with a claimed username, in their own browser
 * context. Signs up through the API (journey 1 covers the sign-up screens),
 * then opens the emailed verification link in the browser, which signs in.
 */
export async function newUser(browser: Browser, label: string, opts: { name?: string } = {}): Promise<TestUser> {
  const email = uniqueEmail(label);
  const name = opts.name ?? `${label[0]!.toUpperCase()}${label.slice(1)} Tester`;
  const context = await browser.newContext({ baseURL: E2E_BASE_URL });
  openContexts.add(context);
  const page = await context.newPage();
  const res = await context.request.post("/api/auth/sign-up/email", {
    data: { email, password: PASSWORD, name, callbackURL: "/workspaces" },
    headers: { origin: E2E_BASE_URL },
  });
  expect(res.ok(), `sign-up ${res.status()} ${await res.text()}`).toBeTruthy();
  const mail = await waitForEmail(context.request, email, "verify-email");
  const link = mail.links.find((l) => l.includes("/verify-email"));
  expect(link, "verification link").toBeTruthy();
  await page.goto(link!);
  await page.waitForURL(/\/workspaces/);
  const username = uniqueUsername(label);
  const claim = await context.request.put("/api/v1/me/username", {
    data: { username },
    headers: { origin: E2E_BASE_URL },
  });
  expect(claim.ok(), `claim username ${claim.status()}`).toBeTruthy();
  await page.reload();
  await dismissCookieNotice(page);
  return { email, name, username, context, page };
}

export async function dismissCookieNotice(page: Page): Promise<void> {
  // The notice appears after hydration; it can cover the composer on small screens.
  const accept = page.getByRole("region", { name: "Cookie notice" }).getByRole("button", { name: "Accept" });
  await accept.click({ timeout: 4_000 }).catch(() => undefined);
}

/** Puts the person on a paid plan through the real checkout + signed-webhook path (`/api/test/subscribe`). */
export async function subscribe(request: APIRequestContext, email: string, plan: "LITE" | "STANDARD" | "PRO"): Promise<void> {
  const res = await request.post("/api/test/subscribe", { data: { email, plan } });
  expect(res.ok(), `subscribe ${res.status()} ${await res.text()}`).toBeTruthy();
}

export function composer(page: Page) {
  return page.getByRole("textbox", { name: "How can Klecx help you today?" });
}

/**
 * Runs `action` (a click that starts an AI answer) and waits until that
 * answer's stream has ended and the saved card is back: earlier answers
 * already show the same fixed text, so waiting for text alone isn't enough.
 */
export async function untilAnswered(page: Page, action: () => Promise<unknown>): Promise<void> {
  const response = page.waitForResponse(
    // A new answer (`/generations`) or a regeneration (`/responses/:id/regenerate`): both stream.
    (r) => r.request().method() === "POST" && /\/(generations|regenerate)$/.test(new URL(r.url()).pathname),
    { timeout: 30_000 }
  );
  await action();
  await (await response).finished();
  await expect(page.locator("main").getByRole("button", { name: "Regenerate" }).last()).toBeVisible();
}

/** Sends a prompt and waits for the fake answer to finish streaming and be saved. */
export async function ask(page: Page, prompt: string): Promise<void> {
  await composer(page).fill(prompt);
  const before = await page.locator("main").getByRole("button", { name: "Regenerate" }).count();
  await untilAnswered(page, () => page.getByRole("button", { name: "Send" }).click());
  await expect(page.getByText("A closing sentence ends the answer.").last()).toBeVisible();
  // The saved card (with its actions) replaces the streaming one.
  await expect(page.locator("main").getByRole("button", { name: "Regenerate" })).toHaveCount(before + 1);
}

/** The person's plan credits left (`GET /api/v1/me/usage/summary`). */
export async function credits(request: APIRequestContext): Promise<number> {
  const res = await request.get("/api/v1/me/usage/summary?period=current");
  expect(res.ok(), `usage summary ${res.status()}`).toBeTruthy();
  return Number((await res.json()).data.remaining);
}

/**
 * Selects an element's text with a real mouse drag, as a person highlighting
 * a passage: from the first character to the last (measured in the page, so
 * the drag never starts in a margin or a list bullet).
 */
export async function selectText(page: Page, target: Locator): Promise<void> {
  // The text can re-render right after an answer is saved: retry on a fresh element.
  await expect(async () => {
    // Pressing inside an existing selection would drag it instead of selecting anew.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await dragOver(page, target);
    await expect(page.getByRole("toolbar", { name: "Annotation actions" })).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 25_000 });
}

async function dragOver(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const pts = await target.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => ((n.textContent ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const first = walker.nextNode() as Text | null;
    let last: Text | null = first;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) last = n;
    if (!first || !last) return null;
    const startOffset = (first.textContent ?? "").search(/\S/);
    const endOffset = (last.textContent ?? "").replace(/\s+$/, "").length;
    const r1 = document.createRange();
    r1.setStart(first, startOffset);
    r1.setEnd(first, startOffset + 1);
    const r2 = document.createRange();
    r2.setStart(last, endOffset - 1);
    r2.setEnd(last, endOffset);
    const a = r1.getBoundingClientRect();
    const b = r2.getBoundingClientRect();
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
  });
  if (!pts) throw new Error("nothing to select");
  await page.mouse.move(pts.x1, pts.y1);
  await page.mouse.down();
  await page.mouse.move(pts.x2, pts.y2, { steps: 10 });
  await page.mouse.up();
}

/** The owner invites `member` to the open workspace from the Share dialog; the member accepts the emailed link. */
export async function inviteAndAccept(owner: TestUser, member: TestUser): Promise<void> {
  const share = await openShare(owner.page);
  await share.getByRole("textbox", { name: "Invite people by email or @username" }).fill(member.email);
  await share.getByRole("button", { name: "Invite" }).click();
  await expect(share.getByRole("tab", { name: "Invitations" })).toBeVisible();
  await share.getByRole("button", { name: "Close dialog" }).click();
  const invite = await waitForEmail(member.context.request, member.email, "invitation");
  const link = invite.links.find((l) => l.includes("/invite/"));
  expect(link, "invitation link").toBeTruthy();
  await member.page.goto(link!);
  await member.page.getByRole("button", { name: /Accept/ }).click();
  await member.page.waitForURL(/\/workspaces\/[0-9a-f-]{36}/);
}

/**
 * Opens the workspace's Share dialog from the top bar. A click right after the
 * first answer can land while the workspace page is still settling and get
 * lost, so it clicks again until the dialog is open.
 */
export async function openShare(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: /^Share/ });
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await page.keyboard.press("Escape");
      await page.getByRole("banner").getByRole("button", { name: "Share" }).click();
    }
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  return dialog;
}
