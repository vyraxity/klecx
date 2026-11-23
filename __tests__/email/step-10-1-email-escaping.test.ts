/**
 * @jest-environment node
 *
 * Step 10.1 — every value people can choose (names, titles, quotes, messages)
 * is HTML-escaped in every email that shows it.
 */
import { renderEmail, type EmailTemplateMap, type EmailTemplateName } from "@/server/email/send";

jest.mock("resend");

const X = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
const URL_ = "https://klecx.example/x?a=1&b=2";

const hostile: Partial<EmailTemplateMap> = {
  "verify-email": { url: URL_, name: X },
  "reset-password": { url: URL_, name: X },
  welcome: { name: X },
  invitation: { inviterName: X, teamOrProjectName: X, inviteUrl: URL_, role: "Editor" },
  "new-sign-in": { time: X, device: X, ipAddress: X, location: X },
  "change-email-confirm": { url: URL_, newEmail: X },
  "share-created": { title: X, shareUrl: URL_ },
  "support-ack": { ticketId: "tk_1", topic: X, message: X, name: X },
  "support-notification": { ticketId: "tk_1", senderEmail: X, topic: X, message: X, diagnostics: X, userId: X },
  "payment-failed": { reason: X, retryUrl: URL_ },
  "ownership-transfer-requested": { fromUserName: X, resourceName: X, acceptUrl: URL_, expiresInDays: 7 },
  "ownership-transfer-accepted": { toUserName: X, resourceName: X },
  "member-suspended": { resourceName: X, reason: X },
  "member-restored": { resourceName: X },
  mentioned: { authorName: X, quote: X, excerpt: X, actionUrl: URL_ },
};

describe("Step 10.1 — email HTML escaping", () => {
  test.each(Object.keys(hostile) as EmailTemplateName[])("%s escapes user values", async (template) => {
    const rendered = await renderEmail(template, "user@example.com", hostile[template] as never, { locale: "en" });
    expect(rendered.html).not.toContain("<script>alert(2)");
    expect(rendered.html).not.toContain('<img src=x onerror="alert(1)">');
    expect(rendered.subject).not.toMatch(/[\r\n]/); // no header injection
  });
});
