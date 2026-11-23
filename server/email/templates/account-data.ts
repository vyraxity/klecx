import "server-only";
import { renderSimpleEmail, appUrl } from "./simple";
import type {
  AccountDeletionScheduledData,
  AccountRestoredData,
  DataExportReadyData,
  EmailTemplateResult,
  EmailTranslator,
} from "./types";

/** Step 9.5: the data export is ready to download (for 24 hours, signed in). */
export function renderDataExportReady(
  data: DataExportReadyData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  return renderSimpleEmail({
    t,
    toEmail,
    subject: t("dataExportReady.subject"),
    heading: t("dataExportReady.heading"),
    greeting: t("dataExportReady.greeting"),
    body: t("dataExportReady.body", { hours: data.hours }),
    actionUrl: appUrl("/settings/data"),
    actionLabel: t("dataExportReady.button"),
    disclaimer: t("dataExportReady.disclaimer"),
  });
}

/** Step 9.5: the account is deleted; the link restores it until the erase date. */
export function renderAccountDeletionScheduled(
  data: AccountDeletionScheduledData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const date = new Date(data.purgeAfter);
  return renderSimpleEmail({
    t,
    toEmail,
    subject: t("accountDeletionScheduled.subject"),
    heading: t("accountDeletionScheduled.heading"),
    greeting: t("accountDeletionScheduled.greeting"),
    body: t("accountDeletionScheduled.body", { date }),
    actionUrl: data.restoreUrl,
    actionLabel: t("accountDeletionScheduled.button"),
    disclaimer: t("accountDeletionScheduled.disclaimer", { date }),
  });
}

/** Step 9.5: the account was restored with the emailed link. */
export function renderAccountRestored(
  _data: AccountRestoredData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  return renderSimpleEmail({
    t,
    toEmail,
    subject: t("accountRestored.subject"),
    heading: t("accountRestored.heading"),
    greeting: t("accountRestored.greeting"),
    body: t("accountRestored.body"),
    actionUrl: appUrl("/auth/login"),
    actionLabel: t("accountRestored.button"),
    disclaimer: t("accountRestored.disclaimer"),
  });
}
