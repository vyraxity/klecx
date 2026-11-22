import "server-only";
import { getSiteConfig } from "@/server/config/site";
import { renderEmailLayout } from "./layout";
import { escapeHtml } from "./escape";
import {
  ChangeEmailConfirmData,
  ChangeEmailVerifyData,
  EmailTemplateResult,
  EmailTranslator,
} from "./types";

/** Step 9.1: email change, step 1 — sent to the current address to approve the change. */
export function renderChangeEmailConfirm(
  data: ChangeEmailConfirmData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  return renderChangeEmail("changeEmailConfirm", data.url, { newEmail: data.newEmail }, t, toEmail);
}

/** Step 9.1: email change, step 2 — sent to the new address to verify it. */
export function renderChangeEmailVerify(
  data: ChangeEmailVerifyData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  return renderChangeEmail("changeEmailVerify", data.url, { newEmail: toEmail }, t, toEmail);
}

function renderChangeEmail(
  ns: "changeEmailConfirm" | "changeEmailVerify",
  url: string,
  values: Record<string, string>,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const site = getSiteConfig();
  const subject = t(`${ns}.subject`);
  const bodyText = t(`${ns}.body`, values);
  const disclaimerText = t(`${ns}.disclaimer`);

  const rendered = renderEmailLayout({
    title: subject,
    heading: t(`${ns}.heading`),
    greeting: t(`${ns}.greeting`),
    bodyHtml: `<p style="margin: 0;">${escapeHtml(bodyText)}</p>`,
    bodyText,
    actionUrl: url,
    actionLabel: t(`${ns}.button`),
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
