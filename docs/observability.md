# Observability and cost monitoring (Step 10.2)

How Klecx tells you about problems — and about money leaking — before people do.

| What | Where | Built in |
| --- | --- | --- |
| Logs (JSON, one line per event, `requestId` on every API line) | Vercel → project → **Logs** | `server/log.ts`, `server/http/route.ts` |
| Code errors (server and browser) with the request id | Sentry (when configured) | `instrumentation*.ts`, `sentry.*.config.ts`, `lib/monitoring/sentry-options.ts` |
| Is the site up? | External uptime monitor on `/` and `/api/ready` | `app/api/health`, `app/api/ready` (F5.4) |
| Business metrics (cost, revenue, latency, funnel…) | `GET /api/v1/admin/metrics?from&to` (admins) | `server/services/metrics.ts` |
| Alerts (provider errors, costs, webhooks, abuse…) | Email to `ALERTS_EMAIL`; history at `GET /api/v1/admin/alerts` | `server/monitoring/alerts.ts` |

## Logs

- One JSON line per event, in Vercel's log viewer. Every API request writes `request` (or `slow request` over 10 s, `request failed` for 5xx) with `requestId`, `method`, the **route pattern** (`/api/v1/workspaces/:id`, never the ids or query string), `status`, `ms` and `userId`.
- **Never logged** (rule 11): passwords, tokens, cookies, `Authorization`, prompts, answers, file contents (keys `prompt`, `content`, `text`, `body`, `instruction`… are replaced with `[redacted]` at any of the first two levels), emails (masked `a***@example.com`). Errors are logged as name + code + first 300 characters of the message (`errInfo()`), never the object.
- `LOG_LEVEL` (default `info`; tests: silent).
- **Finding an error:** a person reports the error id shown on the error page (the `digest`) or an API error's `requestId` → search it in Vercel Logs and in Sentry (tag `request_id` or `digest`).

## Sentry

Off until `NEXT_PUBLIC_SENTRY_DSN` is set. No personal data: `sendDefaultPii: false`; every event loses request bodies, cookies, headers (except the browser's user agent), query strings and every user field but the id (`scrubEvent`). The browser sends events to `/sentry-tunnel` on our own domain (no CSP change, not blocked by ad blockers), which forwards only the event and only for our DSN. Performance tracing is off (`NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0`) to stay in the free plan.

### Setting it up (owner)

Sentry's documentation site couldn't be read from the build environment; labels below may differ slightly.

1. Create a free account at sentry.io (the **Developer** plan is enough to start). Choose the **EU** data region if offered (Klecx's users are worldwide; either works, EU keeps data under GDPR).
2. Create a project: platform **Next.js**, name it `klecx`. Skip the setup wizard (the code is already in place).
3. Copy the project's **DSN** (Project settings → Client Keys (DSN)). It looks like `https://…@o….ingest….sentry.io/…`.
4. In **Vercel → Settings → Environment Variables**, add `NEXT_PUBLIC_SENTRY_DSN` with the DSN for **Production** and **Preview** (and in `.env.local` if you want it locally). The DSN is not a secret, but don't paste it in chat either.
5. Optional, for readable stack traces: in Sentry create an **Organization auth token** (Settings → Auth Tokens) with the default scopes for source maps. In Vercel add `SENTRY_AUTH_TOKEN` (**secret**: tick "Sensitive"), `SENTRY_ORG` (your organization slug) and `SENTRY_PROJECT` (`klecx`), for Production and Preview. Builds then upload source maps and delete them, so they're never served.
6. Redeploy (`NEXT_PUBLIC_*` values are built in).
7. **Alert rules** in Sentry (Alerts → Create alert → Issues): "A new issue is created" → email; and "Number of events in an issue is more than 20 in 1 hour" → email. The default "new issue" alert may already exist.
8. **Check it works:** signed in as an admin on `dev.klecx.com`, call `POST /api/v1/admin/monitoring/test-error` (it fails on purpose and changes nothing). The answer is a 500 with a `requestId`; within a minute the event "Monitoring test error (admin drill)" appears in Sentry (environment `preview`, tag `request_id` = that id), and Vercel → Logs shows an `unhandled error` line with the same `requestId`.

## Uptime monitoring (owner)

Use a free external monitor, e.g. **Better Stack Uptime** (10 monitors and a status page free) or **UptimeRobot** (50 monitors free).

1. Create monitors (every 3–5 minutes, email alert after 2 failures):
   - `https://klecx.com/` — expects HTTP 200 (only once production is public; it's behind deployment protection until launch).
   - `https://klecx.com/api/ready` — expects 200 (503 means the database or Redis is down).
   - The same two on `https://dev.klecx.com` while testing.
2. If the service gives you a public status page, put its address in `STATUS_PAGE_URL` (Vercel, Production): Klecx's `/status` page links to it.
3. A **synthetic sign-in** runs every hour from the Step 10.3 scheduler (`.github/workflows/cron.yml`): a test account signs in and calls `/api/v1/me`; a failure fails the workflow run and GitHub emails you. Setup in `docs/background-jobs.md`.

## Business metrics

`GET /api/v1/admin/metrics?from=2026-11-01&to=2026-11-08` (admins only, at most 92 days, UTC, `to` excluded). For the admin console (`ADMIN_CONSOLE.md` §21). Everything is computed from the rows, so any number can be checked by hand:

- **Generations** per day and kind, success rate, failures by provider category (`auth`, `rate_limit`, `unavailable`, `timeout`, `safety`…).
- **Latency** per model: p50/p95 time to first token (`generations.first_token_at`) and total time.
- **Provider cost** per day, kind and plan = recorded usage × the prices in `lib/ai/model-catalog.ts` (`server/monitoring/costs.ts`), plus each search's own cost: **$0.014 per search query the provider ran** (`PROVIDER_SEARCH_USD`; confirmed 2026-11-24) and the search request's tokens. The first **5,000 search requests a month are free** (account-wide): `searches.monthToDate` shows the month's count against them. Our surcharge is 5 credits ($0.010) per search (`OPEN_DECISIONS.md` §17).
- **Revenue** = `amountPaid` of `subscription.paid` events (gross: Creem's fees and taxes not deducted), per plan; cost-to-revenue ratio.
- Credits burned per plan; searches (count, surcharge vs provider cost); transcription and read-aloud seconds and cost; document-review cost per review; Ask generations per workspace and Ask depth; notes per workspace.
- Billing: payments, refunds (rate, first purchase vs renewal), disputes, failed/unprocessed webhooks.
- Funnel of the people who signed up in the range: signed up → verified → first AI request → paid.
- Plan-limit hits per kind (people and hits).

## Alerts

`runAlertChecks()` (`server/monitoring/alerts.ts`) — run **every hour by the `run-alerts` job** (Step 10.3, `docs/background-jobs.md`) and by an admin with `POST /api/v1/admin/alerts/run`. Thresholds are in `ALERT_THRESHOLDS`.

| Alert | Fires when | Severity |
| --- | --- | --- |
| `provider_errors` | ≥ 10 AI answers in the last hour and ≥ 25 % failed at the provider | critical |
| `provider_auth` | any answer refused for our API key in the last hour (revoked key, billing) | critical |
| `provider_quota` | ≥ 3 answers stopped by quota / rate limit in the last hour | critical |
| `webhook_failures` | a billing webhook failed in 24 h, or was received but not processed after 15 min | critical |
| `account_cost:<user>` | one account cost > $2 (Free/Lite), $5 (Standard), $10 (Pro) at the provider in 24 h | warning |
| `cost_vs_revenue` | (billing on) the day's provider cost > 60 % of the 30-day average daily revenue | warning |
| `limit_abuse:<user>:<limit>` | someone hit the same plan limit on ≥ 3 days in the last 7 (abuse, or a plan too small) | warning |
| `stuck_generations` | an AI request still running after 15 min (`reap-generations` cleans them up after 10 min, so this means the job isn't running) | warning |
| `job_failed:<job>` | a background job's last run (within 24 h) failed, or some of its items failed | warning |
| `job_stuck:<job>` | a background job run started > 15 min ago and never finished (its function was killed) | warning |
| `job_overdue:<job>` | a job that has run before hasn't succeeded for 3 of its intervals + 30 min (the scheduler stopped, or `CRON_SECRET` changed) | critical |
| `billing_drift` | the daily `reconcile-billing` found subscriptions that differ from Creem (missed webhooks; ids in the logs) | warning |
| `search_cap_near` / `search_cap_reached` | Klecx's grounded searches today reach 80 % / 100 % of the provider's 1,500-a-day cap (account-wide; at 100 % searches stop until midnight UTC) | warning / critical |
| `db_connections` | ≥ 80 % of the database's connections in use (where the host shows it) | critical |

Each alert is emailed to `ALERTS_EMAIL` (default `BILLING_EMAIL`) once, then not again for 1 hour (critical) or 6 hours (warning) while it keeps firing; `monitoring_alerts` keeps the history. Code errors and error spikes are Sentry's alerts (above). If the scheduler itself stops, these alerts stop too (they run from it): the uptime monitors and GitHub's email about a failed workflow run cover that.

**Drill:** on `dev.klecx.com`, call `POST /api/v1/admin/alerts/run` as an admin; the response lists what fires, and an email arrives for anything new. The test `__tests__/step-10-2-observability.test.ts` runs the same drill on seeded data.

## Calling the admin endpoints before the admin console exists

- **Becoming an admin** (once per environment): in the database, set `users.role` to `ADMIN` for your own account, e.g. with `npx prisma studio` (pointing at that environment's `DATABASE_URL`) → `User` → your row → `role` = `ADMIN` → Save. Sign out and back in.
- Signed in on the site, open the browser's developer tools → **Console** and run, for example:
  - `await (await fetch("/api/v1/admin/metrics?from=2026-11-01&to=2026-11-08")).json()`
  - `await (await fetch("/api/v1/admin/alerts/run", { method: "POST" })).json()`
  - `await (await fetch("/api/v1/admin/monitoring/test-error", { method: "POST" })).json()`
