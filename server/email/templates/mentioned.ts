import "server-only";
import { renderSimpleEmail, appUrl } from "./simple";
import type {
  EmailTemplateResult,
  EmailTranslator,
  MentionedData,
} from "./types";

export function renderMentioned(
  data: MentionedData,
  t: EmailTranslator,
  toEmail: string
): EmailTemplateResult {
  const values = {
    authorName: data.authorName,
    quote: data.quote ? `«${data.quote}»` : "",
    excerpt: data.excerpt,
  };

  // `@all`: say everyone was mentioned, not "you".
  const v = data.everyone ? "Everyone" : "";
  return renderSimpleEmail({
    t,
    toEmail,
    subject: t(`mentioned.subject${v}`, values),
    heading: t(`mentioned.heading${v}`, values),
    greeting: t("mentioned.greeting", values),
    body: t(`mentioned.body${v}`, values),
    actionUrl: data.actionUrl ?? appUrl("/workspaces"),
    actionLabel: t("mentioned.button"),
    disclaimer: t("mentioned.disclaimer"),
  });
}
