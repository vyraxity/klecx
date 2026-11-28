import "server-only";
import { getSiteConfig } from "@/server/config/site";
import { renderEmailLayout } from "./layout";
import { escapeHtml } from "./escape";
import { EmailTemplateResult, EmailTranslator, PasswordSetCodeData } from "./types";

/**
 * Pre-10.6 fix: the 6-digit code that confirms adding a password to an
 * account that signs in only with a connected account (Settings → Security).
 */
export function renderPasswordSetCode(
  data: PasswordSetCodeData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const site = getSiteConfig();
  const subject = t("passwordSetCode.subject", { code: data.code });
  const heading = t("passwordSetCode.heading");
  const bodyText = t("passwordSetCode.body", { minutes: data.minutes });
  const disclaimerText = t("passwordSetCode.disclaimer");
  const code = escapeHtml(data.code);

  const rendered = renderEmailLayout({
    title: subject,
    heading,
    greeting: t("passwordSetCode.greeting"),
    bodyHtml:
      `<p style="margin: 0 0 16px;">${escapeHtml(bodyText)}</p>` +
      `<p style="margin: 0; font-size: 28px; font-weight: 700; letter-spacing: 6px; font-family: ui-monospace, Menlo, Consolas, monospace;">${code}</p>`,
    bodyText: `${bodyText}\n\n${data.code}`,
    disclaimerHtml: escapeHtml(disclaimerText),
    disclaimerText,
    toEmail,
    supportEmail: site.emails.support,
    copyUrlNotice: t("layout.copyUrlNotice"),
    supportNotice: t("layout.supportNotice", { supportEmail: site.emails.support }),
    legalNotice: t("layout.legalNotice", {
      companyLegalName: site.company.legalName,
      companyAddress: site.company.address,
      year: new Date().getFullYear().toString(),
    }),
    merchantOfRecordNotice: site.billingEnabled ? t("layout.merchantOfRecordNotice") : undefined,
    transactionalDisclaimer: t("layout.transactionalDisclaimer", { email: toEmail }),
  });

  return { subject, html: rendered.html, text: rendered.text };
}
