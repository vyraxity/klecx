# Server Billing

Plan definitions, entitlements, and the billing provider (Step 8.2).

- `plans.ts` — the only place with plan facts (`PLANS`).
- `entitlements.ts` — effective plan from the `Subscription` row (`resolveSubscriptionPlan`, `getEntitlements`).
- `provider.ts` — the `BillingProvider` interface. Nothing outside this folder talks to Creem directly.
- `creem.ts` — the Creem adapter (plain `fetch`, `x-api-key`, 10 s timeout, no retries) and the plan + interval → product id map.
- `get-provider.ts` — builds the configured provider from env (`BILLING_PROVIDER`, `CREEM_*`); null while billing isn't set up.

The routes call `server/services/billing.ts`. Subscription state changes only through provider webhooks (Step 8.3).
