import "server-only";
import { getSiteConfig } from "@/server/config/site";
import { renderEmailLayout } from "./layout";
import { escapeHtml } from "./escape";
import { EmailTemplateResult, EmailTranslator, TwoFactorChangedData } from "./types";

/** Two-factor sign-in was turned on or off, or new backup codes were made. */
export function renderTwoFactorChanged(
  data: TwoFactorChangedData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const site = getSiteConfig();
  const k = `twoFactorChanged.${data.kind}`;
  const subject = t(`${k}.subject`);
  const heading = t(`${k}.heading`);
  const bodyText = t(`${k}.body`, { time: data.time });
  const disclaimerText = t("twoFactorChanged.disclaimer");

  const rendered = renderEmailLayout({
    title: subject,
    heading,
    greeting: t("twoFactorChanged.greeting"),
    bodyHtml: `<p style="margin: 0;">${escapeHtml(bodyText)}</p>`,
    bodyText,
    actionUrl: `${site.appUrl}/settings/security`,
    actionLabel: t("twoFactorChanged.button"),
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
