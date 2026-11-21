import "server-only";

/**
 * Throwaway-inbox domains refused at sign-up (Step 8.4, abuse guard for the
 * monthly Free credits, with one Free allowance per verified email and the
 * per-IP sign-up limit). A short list of the most used services; subdomains
 * match too. Extend it here when support sees a new one.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spam4.me",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.dev",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  if (!domain) return false;
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}
