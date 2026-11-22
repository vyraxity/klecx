import "server-only";
import { db } from "@/server/db/client";
import { Errors } from "@/server/http/errors";
import { getSiteConfig } from "@/server/config/site";
import { sendEmail } from "@/server/email/send";
import { getRefundEligibilityForUser } from "@/server/billing/refunds";
import type { Actor } from "@/server/auth/session";
import type { SupportTicketInput } from "@/lib/schemas/support";
import {
  prepareSupportScreenshots,
  storeSupportScreenshots,
  supportScreenshotLinks,
  type IncomingScreenshot,
} from "@/server/services/support-screenshots";

/**
 * Strips ASCII control characters (0x00 - 0x1F except tab, CR, LF, and 0x7F DEL)
 */
function stripControlCharacters(str: string): string {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Billing requests from a signed-in subscriber carry the refund policy check (Step 8.4). */
async function billingRefundCheck(actor: Actor | null, topic: string) {
  if (!actor || topic !== "billing") return undefined;
  try {
    const result = await getRefundEligibilityForUser(actor.userId);
    if (!result) return undefined;
    return {
      eligible: result.eligible,
      rule: result.rule,
      creditsUsedPct: result.creditsUsedPct,
      daysSincePayment: result.daysSincePayment,
      paymentNumber: result.paymentNumber,
      previousRefunds: result.previousRefunds,
    };
  } catch (err) {
    console.error("[SupportService] Refund eligibility failed:", err instanceof Error ? err.message : "unknown");
    return undefined;
  }
}

export async function createSupportTicket(
  actor: Actor | null,
  input: SupportTicketInput,
  options: { screenshots?: IncomingScreenshot[]; locale?: string } = {}
): Promise<{ success: boolean; ticketId: string; screenshotCount: number }> {
  // Honeypot check: If the hidden honeypot field is populated, silently return success without persisting
  if (input.website && input.website.trim().length > 0) {
    return {
      success: true,
      ticketId: "tk_" + crypto.randomUUID().slice(0, 8),
      screenshotCount: 0,
    };
  }

  // Check every screenshot before anything is stored (422 on the first problem).
  const screenshots = await prepareSupportScreenshots(options.screenshots ?? []);

  const cleanEmail = stripControlCharacters(input.email.trim().toLowerCase());
  const cleanTopic = stripControlCharacters(input.topic.trim());
  const cleanMessage = stripControlCharacters(input.message.trim());
  const cleanName = input.name ? stripControlCharacters(input.name.trim()) : undefined;

  // Store SupportTicket in DB
  const ticket = await db.supportTicket.create({
    data: {
      userId: actor?.userId ?? null,
      email: cleanEmail,
      topic: cleanTopic,
      message: cleanMessage,
      diagnostics: input.diagnostics ? JSON.parse(JSON.stringify(input.diagnostics)) : undefined,
    },
  });

  let attachments: Awaited<ReturnType<typeof storeSupportScreenshots>> = [];
  try {
    attachments = await storeSupportScreenshots(ticket.id, screenshots);
  } catch (err) {
    // Don't keep a ticket whose screenshots are missing: the person can retry.
    await db.supportTicket.delete({ where: { id: ticket.id } }).catch(() => {});
    console.error("[SupportService] Failed to store support screenshots:", err instanceof Error ? err.message : "unknown");
    throw Errors.unprocessable("Screenshots could not be stored", "upload_failed");
  }

  // Fire emails in the background / try-catch so failures to deliver do not break ticket submission
  try {
    // 1. Send acknowledgement to the submitter
    await sendEmail("support-ack", cleanEmail, {
      ticketId: ticket.id,
      topic: cleanTopic,
      message: cleanMessage,
      name: cleanName,
      screenshotCount: attachments.length,
    }, { locale: options.locale });
  } catch (err) {
    console.error("[SupportService] Failed to send user acknowledgement email:", err);
  }

  try {
    // 2. Send notification to the support inbox
    const site = getSiteConfig();
    await sendEmail("support-notification", site.emails.support, {
      ticketId: ticket.id,
      senderEmail: cleanEmail,
      topic: cleanTopic,
      message: cleanMessage,
      userId: actor?.userId,
      diagnostics: input.diagnostics
        ? JSON.stringify(input.diagnostics, null, 2)
        : undefined,
      // Signed links that expire after 7 days; never the files themselves.
      screenshotLinks: await supportScreenshotLinks(attachments),
      refundEligibility: await billingRefundCheck(actor, cleanTopic),
    });
  } catch (err) {
    console.error("[SupportService] Failed to send support team notification email:", err);
  }

  return {
    success: true,
    ticketId: ticket.id,
    screenshotCount: attachments.length,
  };
}

/** Step 9.1: Settings → Support lists the person's own requests (sent while signed in). */
export const MY_TICKETS_LIMIT = 20;
const TICKET_EXCERPT_CHARS = 160;

export async function listMySupportTickets(userId: string) {
  const tickets = await db.supportTicket.findMany({
    where: { userId },
    select: {
      id: true,
      topic: true,
      message: true,
      status: true,
      createdAt: true,
      _count: { select: { attachments: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MY_TICKETS_LIMIT,
  });
  return tickets.map((t) => ({
    id: t.id,
    topic: t.topic,
    excerpt:
      t.message.length > TICKET_EXCERPT_CHARS
        ? `${t.message.slice(0, TICKET_EXCERPT_CHARS).trimEnd()}…`
        : t.message,
    status: t.status,
    createdAt: t.createdAt,
    screenshotCount: t._count.attachments,
  }));
}
