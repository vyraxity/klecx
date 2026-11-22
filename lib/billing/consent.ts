/**
 * Consent to immediate start (Step 8.5, owner decided 2026-11-21). Before a
 * checkout or an upgrade the person ticks a box asking for the plan to start
 * at once and acknowledging that, where the law gives one (EU/UK consumers),
 * they lose the 14-day right of withdrawal once it has started; the refund
 * policy still applies. Shown to everyone: Klecx can't reliably tell a buyer's
 * country before checkout. The server refuses a checkout or upgrade without
 * it and stores a `BillingConsent` row with this version.
 *
 * Bump the version whenever the wording (`Billing.consent.label` in any
 * locale) changes.
 */
export const CHECKOUT_CONSENT_VERSION = "2026-11-21";
