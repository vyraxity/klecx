# Admin console — backlog

The owner will build an **admin console in a separate codebase** (owner's plan, 2026-11-21), so that managing users and troubleshooting never needs raw database edits. This file lists what that console needs. It is a backlog, not a design: each entry says **what** an admin must be able to do, **why**, and **what exists in this app today** (the service, table or endpoint the console can use, and what is still missing).

How to use this file:

- **Add** an entry whenever a step or review builds something that today needs a database edit, a log search or a provider dashboard to manage or fix (rule in `CLAUDE.md`). Give it the next number and the step that found it.
- **Don't build the console here.** If a step needs an admin action right away, add the service function (and, when useful, an `/api/v1/admin/*` route restricted to `role = ADMIN`) and record it here.
- **Open question for the owner:** how the separate console talks to Klecx. Either through admin API routes in this app (`/api/v1/admin/*`, today only `POST /api/v1/admin/users/:id/reset-username-limit`), which keep the business rules in one place, or directly to the database (faster to build, but every rule would be written twice). Recommended: admin API routes.

---

## Billing and credits

### 1. Clear a payment dispute
- **Found:** Step 8.3.
- **Why:** `dispute.created` sets `Subscription.status = DISPUTED`, which freezes the account's credits (`reserve()` throws `billing_frozen`). DISPUTED is sticky: no later Creem event lifts it. When the dispute is won or settled, an admin must set the subscription back (to ACTIVE, or CANCELED/EXPIRED if it ended).
- **Today:** a database edit of `subscriptions.status`. Needed: a service function that sets the new status, writes an audit entry and, if the plan changes, calls `applyMemberLimitForPlanChange()`.

### 2. Dispute evidence
- **Found:** Step 8.3.
- **Why:** Creem asks the merchant for evidence (usage, dates). The admin needs the person's credit ledger, activity log and billing events for the disputed payment, exportable.
- **Today:** `credit_ledger`, `activity_log`, `billing_events` and `billing_consents` (the consent to immediate start given before each checkout and upgrade, with the wording version; Step 8.5) tables only.

### 3. Add or remove credits by hand
- **Found:** Steps 8.3 / 8.4.
- **Why:** a lost `subscription.paid` message (`OPEN_DECISIONS.md` §7), an outage the refund policy compensates, a support gesture.
- **Today:** `adjust()` in `server/services/credits.ts` (writes an `ADJUST` ledger entry with `actorId` and a reason). No route or UI calls it.

### 4. Billing events inbox
- **Found:** Step 8.3.
- **Why:** webhook events that failed (`status = FAILED`) or were ignored for a reason that needs a person: `user_not_found`, `unknown_product`, `other_subscription`, `paid_other_subscription`, `refund_without_grant`, `refunded_before_paid`. Each one also emails `BILLING_EMAIL` today (`billing-alert`), with ids only.
- **Today:** the `billing_events` table (payload kept forever). Needed: a list with filters, the payload, and a **re-run** action (process the stored event again, same idempotency rules).

### 5. Subscription lookup and actions
- **Found:** Step 8.3.
- **Why:** find a person's subscription from their email or from a Creem customer / subscription id, see its status, period and effective plan, and cancel it (at period end or immediately).
- **Today:** `subscriptions` table; `cancelSubscription()` in `server/services/billing.ts` (period end only, for the person themselves); immediate cancellation only in the Creem dashboard.

### 6. Refund decisions
- **Found:** Step 8.4.
- **Why:** support must check the refund policy before refunding.
- **Today:** `getRefundEligibility(subscriptionId)` in `server/billing/refunds.ts`; billing support emails already include it. The refund itself is issued in the Creem dashboard, and the `refund.created` webhook does the rest. Needed: the eligibility on the subscription page, and a note of who approved the refund.

### 7. Credit grants overview
- **Found:** Step 8.4.
- **Why:** answer "why do I have N credits?" without reading the ledger by hand: the current allowance (`CreditAccount.allowancePlan` / `allowanceKey`), when it resets, and the last grants, expiries and refunds.
- **Today:** `credit_accounts`, `credit_ledger`; `decideGrant()` in `server/billing/grants.ts` explains what the next grant will be.

## Users and collaboration

### 8. Collaborator limit grace periods
- **Found:** F1.3 / Step 8.4.
- **Why:** see owners over their collaborator limit, when their 14-day grace ends, who was suspended; extend a grace or restore people as a support gesture.
- **Today:** `member_limit_grace` table (`enforcedAt` set once enforcement ran); `startOverLimitGrace()`, `enforceMemberLimit()`, `restoreWithinLimit()` in `server/services/member-limits.ts`.

### 9. Reset a person's username-change limit
- **Found:** earlier steps.
- **Today:** `POST /api/v1/admin/users/:id/reset-username-limit` (admins only). The console only needs a button.

### 10. Blocked sign-up email domains
- **Found:** Step 8.4.
- **Why:** add a newly seen throwaway-inbox domain without a code change and deploy.
- **Today:** a hard-coded list in `server/auth/disposable-email.ts`. Needed: a table (or setting) the list is read from, plus the console screen.

## Support

### 11. Support tickets
- **Found:** F5.8 / Step 8.4.
- **Why:** today every request is only an email to `SUPPORT_EMAIL` (and a `support_tickets` row). A console view would show the ticket, the person's plan and subscription, the refund check for billing topics, and the screenshots (signed links expire after 7 days).
- **Today:** `support_tickets`, `support_attachments` tables; `supportScreenshotLinks()` in `server/services/support-screenshots.ts`.

### 12. Change a customer's plan by hand
- **Found:** Step 8.5.
- **Why:** downgrades aren't self-service (`OPEN_DECISIONS.md` §9); support may move someone to a smaller plan or another billing period, or fix a plan after a mistake.
- **Today:** only in Creem's dashboard ("Modify Subscription"). The `subscription.update` webhook then syncs `Subscription.plan`, but nothing adjusts the credits or `CreditAccount.allowancePlan`. Needed: an admin action that calls the provider's plan change (`changeSubscriptionPlan()`) with the chosen proration and sets the credits deliberately (`adjust()`), with an audit entry.

### 13. Checkout and activation troubleshooting
- **Found:** Step 8.5.
- **Why:** "I paid but my plan isn't active" (the billing page says so after 60 s). The admin needs the person's `billing_checkouts` (our checkout ids sent as `request_id`), the matching `billing_events` and their status, side by side.
- **Today:** the `billing_checkouts` and `billing_events` tables only.
