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
- **Step 9.1:** Settings → Support now shows each person their own requests **with their status** (`GET /api/v1/me/support-tickets`). Nothing in the app changes `support_tickets.status`, so every request shows **Open** until an admin sets it (today a database edit). The console needs "set status" (Open / In progress / Resolved / Closed) on a ticket.

### 12. Change a customer's plan by hand
- **Found:** Step 8.5.
- **Why:** downgrades aren't self-service (`OPEN_DECISIONS.md` §9); support may move someone to a smaller plan or another billing period, or fix a plan after a mistake.
- **Today:** only in Creem's dashboard ("Modify Subscription"). The `subscription.update` webhook then syncs `Subscription.plan`, but nothing adjusts the credits or `CreditAccount.allowancePlan`. Needed: an admin action that calls the provider's plan change (`changeSubscriptionPlan()`) with the chosen proration and sets the credits deliberately (`adjust()`), with an audit entry.

### 13. Checkout and activation troubleshooting
- **Found:** Step 8.5.
- **Why:** "I paid but my plan isn't active" (the billing page says so after 60 s). The admin needs the person's `billing_checkouts` (our checkout ids sent as `request_id`), the matching `billing_events` and their status, side by side.
- **Today:** the `billing_checkouts` and `billing_events` tables only.

### 14. Suspend an account, freeze its credits
- **Found:** Step 8.6.
- **Why:** abuse reports and AUP violations (Creem asks merchants to be able to act on abuse), fraud, card testing.
- **Today:** built in this app (admins only, `User.role = ADMIN`, every change in `audit_logs`): `POST /api/v1/admin/users/:id/suspend { reason, freezeCredits? }` (sign-in refused with `ACCOUNT_SUSPENDED`, all sessions revoked), `/unsuspend`, `/freeze-credits { reason }` (`reserve()` → 403 `credits_frozen`), `/unfreeze-credits` (`server/services/account-moderation.ts`). The console needs the screens: find a person, see `suspendedAt` / `frozenAt` and the reason, act, and read the audit history.

### 15. Account access recovery (email and sign-in methods)
- **Found:** Step 9.1.
- **Why:** someone who lost access to their email inbox can't change their email address (Settings → Profile sends the approval link to the **current** address first), and someone whose only sign-in method is a social account they lost can't get back in. Support has to verify the person, then change the email or the sign-in methods for them.
- **Today:** the person's own actions only: `POST /api/v1/me/email` (Better Auth's two-step change), `GET /api/v1/me/linked-accounts`, `DELETE /api/v1/me/linked-accounts/:provider` (`server/services/account-security.ts`; never the last method; `ACCOUNT_UNLINKED` and `PASSWORD_CHANGED` in `audit_logs`). Needed: admin actions to see a person's sign-in methods (the `accounts` table, provider ids only), change the email directly (then revoke sessions and email both addresses), remove a sign-in method or send a set-password link, each with an audit entry.

### 16. A person's usage and credit history
- **Found:** Step 9.3.
- **Why:** "where did my credits go?", disputes and refund checks (the refund policy depends on how much of a payment was used) need the same view the person has, from the admin side.
- **Today:** `getUsageSummary()`, `getUsageTimeseries()`, `getUsageByMember()` and `listCreditHistory()` in `server/services/usage.ts` take a user id; the `/api/v1/me/*` routes only serve the signed-in person. Needed: admin routes (or console reads) that call these for a looked-up user, read-only.

### 17. Read-aloud audio cache
- **Found:** Step 9.4.
- **Why:** a wrongly pronounced or broken clip should be regenerated, and storage use watched; also to see how much natural-voice audio a person generated (support, refund checks).
- **Today:** `speech_cache` rows (key, voice, model, seconds, `storage_id`, `last_used_at`) and the private MP3 files under `<CLOUDINARY_UPLOAD_FOLDER>/speech/` in storage; SPEECH generations (with `usage.seconds`) per person. Needed: list/search cache entries, delete one (file + row: the next play regenerates it), and a person's read-aloud history (already in their usage page via `kind = SPEECH`).

### 18. Account deletions (restore on someone's behalf, erase now)
- **Found:** Step 9.5.
- **Why:** someone who deleted their account by mistake and lost the restore email asks support to bring it back; a verified erasure request (privacy law) may need the data erased before the 30 days are over; an erase that failed (a storage error) needs to be retried and watched.
- **Today:** `account_deletions` rows (`requested_at`, `purge_after`, `purged_at`) and `users.deleted_at`; `restoreAccount(token)` only works with the emailed token; `purgeDueAccounts()` erases accounts past their 30 days (to be scheduled daily in Step 10.3); `POST /api/v1/admin/users/:id/purge-deleted { force? }` (admins only, audit-logged) erases one deleted account now (`force` before the 30 days are over). `ACCOUNT_DELETION_REQUESTED`, `ACCOUNT_DELETION_CANCELLED`, `ACCOUNT_PURGED` in `audit_logs`. Needed: find deleted accounts and their erase dates, restore one for a verified person (same effect as the link: clear `deleted_at`, the notes deleted with it and the `account_deleted` membership suspensions), erase now, and see failed erases.

### 19. Data exports
- **Found:** Step 9.5.
- **Why:** an export that failed or never arrived ("I didn't get the email"), or a person asking for a second copy the same day.
- **Today:** `data_exports` rows (status, size, files included/left out, `error_code`, `expires_at`); one per person per 24 hours (`requestDataExport()`), built by `buildDataExport(id)` (`server/services/data-export.ts`). Needed: see a person's exports and their status, re-run a failed one, and allow an extra export.

### 20. Two-factor sign-in reset
- **Found:** two-factor sign-in (after Step 10.1).
- **Why:** someone who lost their phone **and** their backup codes can't sign in with their password any more. Support verifies who they are (they write from the account's address; ask for details only the owner would know, e.g. recent workspace titles or their plan and payment date) and then removes two-factor so they can sign in and turn it on again. A locked challenge (too many wrong codes) also lifts by itself after a few minutes.
- **Today:** `users.two_factor_enabled` and the `two_factors` row (encrypted secret and backup codes, `failed_verification_count`, `locked_until`); trusted devices are `verification` rows whose identifier starts with `trust-device-` and whose value is the user id. `POST /api/v1/admin/users/:id/reset-two-factor` (admins only, `server/services/two-factor.ts` → `adminResetTwoFactor()`) removes all of it, writes `ADMIN_RESET_TWO_FACTOR` to `audit_logs` and emails the person. Other changes are logged as `TWO_FACTOR_ENABLED`, `TWO_FACTOR_DISABLED` and `TWO_FACTOR_BACKUP_CODES_REGENERATED`. Needed: see whether a person has two-factor on (and whether it is locked right now), reset it with a required note of how identity was checked, and see the history of those audit entries.

### 21. Metrics, alerts and error drills
- **Found:** Step 10.2.
- **Why:** the owner needs to see cost against revenue, failures, latency and the sign-up funnel without SQL, see which alerts fired (and silence or acknowledge them), and check monitoring end to end.
- **Today:** `GET /api/v1/admin/metrics?from&to` (≤ 92 days, UTC; `server/services/metrics.ts`): generations per day/kind, success rate and failures by provider category, p50/p95 time to first token and total time per model, provider cost per day/kind/plan, revenue per plan and cost-to-revenue, credits burned per plan, searches (surcharge vs provider cost), transcription and read-aloud seconds/cost, review cost, Asks per workspace and depth, notes, refunds (first purchase vs renewal), disputes, webhook failures, funnel, plan-limit hits. `GET /api/v1/admin/alerts?limit` (history from `monitoring_alerts`), `POST /api/v1/admin/alerts/run` (run the checks now), `POST /api/v1/admin/monitoring/test-error` (a deliberate 500 for the Sentry/log drill). Thresholds are code constants (`ALERT_THRESHOLDS` in `server/monitoring/alerts.ts`). Needed: charts for the metrics, the alert list with "acknowledge" (today alerts can't be silenced except by fixing the cause), editable thresholds, a per-person view of `usage_limit_hits`, and a link from an alert to the account it names.

### 22. Background jobs
- **Found:** Step 10.3.
- **Why:** the housekeeping jobs (crash recovery, email retries, file clean-up, erasing deleted accounts and workspaces, credit periods, member limits, billing reconcile) run on a schedule; an admin needs to see when each last ran and what it did, why one failed, and run one now (after a fix, or before the next schedule).
- **Today:** `job_runs` (one row per run: job, status, start/end, counts, error code; 30 days) and `job_locks` (the lease of a running job). A job runs now with `POST /api/cron/<job>` and `Authorization: Bearer <CRON_SECRET>`, or from GitHub (Actions → cron → Run workflow, a whole group). Failed, unfinished and overdue jobs raise alerts (`job_failed`, `job_stuck`, `job_overdue`). Needed: a jobs page (last run per job, history, "run now" through an admin route that calls `runJob()` instead of the cron secret), and the error details (today: the logs, by job name).

### 23. Subscriptions out of step with Creem
- **Found:** Step 10.3.
- **Why:** the daily `reconcile-billing` job compares every live subscription with Creem (`GET /v1/subscriptions`) to catch missed webhooks. It only **detects**: a wrong guess would grant or take credits. Each drift is logged (`billing drift`, with our subscription id, both statuses and the reason: `status`, `scheduled_cancel`, `cancel_flag`, `period_end`, `missing_at_provider`) and raises the `billing_drift` alert.
- **Today:** the admin reads the log line, checks the subscription in Creem's dashboard and fixes it: usually by having Creem resend the missed webhook (the state machine applies it), otherwise a database edit of `subscriptions`. Needed: a drift list (local vs Creem side by side), "re-sync from Creem" that runs the matching state-machine transition, and credits adjustments (§3) when a payment was missed.
