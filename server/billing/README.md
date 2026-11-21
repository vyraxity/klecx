# Server Billing

Plan definitions, entitlements, the billing provider (Step 8.2) and its webhooks (Step 8.3).

- `plans.ts` — the only place with plan facts (`PLANS`).
- `entitlements.ts` — effective plan from the `Subscription` row (`resolveSubscriptionPlan`, `getEntitlements`).
- `provider.ts` — the `BillingProvider` interface. Nothing outside this folder talks to Creem directly.
- `creem.ts` — the Creem adapter (plain `fetch`, `x-api-key`, 10 s timeout, no retries) and the plan + interval → product id map.
- `get-provider.ts` — builds the configured provider from env (`BILLING_PROVIDER`, `CREEM_*`); null while billing isn't set up.

- `grants.ts` — the credit grant lifecycle (Step 8.4): `ensureCurrentGrant()` gives each account the allowance of the current period (monthly Free, yearly month by month, expiry when a paid plan ends) and enforces ended collaborator grace periods. Called by `reserve()` and wherever a balance is shown.
- `refunds.ts` — `getRefundEligibility()`: the refund policy computed from the ledger, for support.
- `handlers.ts` — the webhook state machine (Step 8.3): `applyBillingEvent()` turns a verified event into subscription changes and credit grants inside one transaction and returns the side effects (notifications, collaborator limits, provider calls, alerts) to run after the commit.

The routes call `server/services/billing.ts`. Subscription state changes only through provider webhooks:
`POST /api/webhooks/creem` → `server/services/billing-webhook.ts` (signature on the raw body, one
`BillingEvent` row per provider event id, row lock so retries never double-apply, 500 on failure so
the provider retries). Every payload is kept in `BillingEvent.payload` as the audit trail.
