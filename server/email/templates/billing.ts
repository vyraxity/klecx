import "server-only";
import { getSiteConfig } from "@/server/config/site";
import { renderEmailLayout } from "./layout";
import { escapeHtml } from "./escape";
import { renderSimpleEmail } from "./simple";
import type {
  BillingAlertData,
  EmailTemplateResult,
  EmailTranslator,
  SubscriptionChangedData,
} from "./types";

/**
 * Step 8.3 billing emails.
 * - `subscription-changed`: to the subscriber, one text per change (`kind`).
 * - `billing-alert`: to the billing inbox (disputes, events that couldn't be
 *   matched to a person). Ids only, never the payload.
 */

const DATE_KINDS = new Set(["cancel_scheduled"]);

export function renderSubscriptionChanged(
  data: SubscriptionChangedData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const k = `subscriptionChanged.${data.kind}`;
  const date = data.periodEnd ? new Date(data.periodEnd) : null;
  const body =
    DATE_KINDS.has(data.kind) && date && !Number.isNaN(date.getTime())
      ? t(`${k}.bodyWithDate`, { date })
      : t(`${k}.body`);
  return renderSimpleEmail({
    t,
    toEmail,
    subject: t(`${k}.subject`),
    heading: t(`${k}.heading`),
    greeting: t("subscriptionChanged.greeting"),
    body,
    actionUrl: data.actionUrl,
    actionLabel: t("subscriptionChanged.button"),
    disclaimer: t("subscriptionChanged.disclaimer"),
  });
}

export function renderBillingAlert(
  data: BillingAlertData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const site = getSiteConfig();
  const subject = t("billingAlert.subject", { reason: data.reason });
  const lines = [
    t("billingAlert.body"),
    t("billingAlert.reason", { reason: data.reason }),
    t("billingAlert.event", { type: data.eventType, id: data.eventId }),
    t("billingAlert.user", { userId: data.userId ?? "—" }),
  ];
  const rendered = renderEmailLayout({
    title: subject,
    heading: t("billingAlert.heading"),
    greeting: t("billingAlert.greeting"),
    bodyHtml: lines.map((l) => `<p style="margin: 0 0 8px;">${escapeHtml(l)}</p>`).join(""),
    bodyText: lines.join("\n"),
    disclaimerHtml: escapeHtml(t("billingAlert.disclaimer")),
    disclaimerText: t("billingAlert.disclaimer"),
    toEmail,
    supportEmail: site.emails.support,
    copyUrlNotice: t("layout.copyUrlNotice"),
    supportNotice: t("layout.supportNotice", { supportEmail: site.emails.support }),
    legalNotice: t("layout.legalNotice", {
      companyLegalName: site.company.legalName,
      companyAddress: site.company.address,
      year: new Date().getFullYear().toString(),
    }),
    transactionalDisclaimer: t("layout.transactionalDisclaimer", { email: toEmail }),
  });
  return { subject, html: rendered.html, text: rendered.text };
}
