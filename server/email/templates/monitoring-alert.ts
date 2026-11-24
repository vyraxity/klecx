import "server-only";
import { getSiteConfig } from "@/server/config/site";
import { renderEmailLayout } from "./layout";
import { escapeHtml } from "./escape";
import { EmailTemplateResult, EmailTranslator, MonitoringAlertData } from "./types";

/**
 * Step 10.2: internal alert email to ALERTS_EMAIL. One line per alert, from
 * `Email.monitoringAlert.kinds.<kind>` with the alert's numbers (ids only,
 * never names, emails or content).
 */
export function renderMonitoringAlert(
  data: MonitoringAlertData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const site = getSiteConfig();
  const critical = data.alerts.filter((a) => a.severity === "critical").length;
  const subject = t("monitoringAlert.subject", { count: data.alerts.length, critical });
  const lines = data.alerts.map((a) => {
    const label = t(`monitoringAlert.severity.${a.severity}`);
    return `${label} · ${t(`monitoringAlert.kinds.${a.kind}`, a.values)}`;
  });
  const intro = t("monitoringAlert.body", { time: data.time });
  const rendered = renderEmailLayout({
    title: subject,
    heading: t("monitoringAlert.heading"),
    greeting: t("monitoringAlert.greeting"),
    bodyHtml:
      `<p style="margin: 0 0 12px;">${escapeHtml(intro)}</p>` +
      lines.map((l) => `<p style="margin: 0 0 8px;">${escapeHtml(l)}</p>`).join(""),
    bodyText: [intro, "", ...lines].join("\n"),
    disclaimerHtml: escapeHtml(t("monitoringAlert.disclaimer")),
    disclaimerText: t("monitoringAlert.disclaimer"),
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
