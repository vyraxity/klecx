# Background jobs (Step 10.3)

Klecx's housekeeping runs as **jobs**: small, idempotent tasks that a scheduler calls over HTTP. The code is in `server/jobs/`, the list and how often each runs in `lib/jobs/schedules.ts`, the endpoint is `POST /api/cron/<job>` (`GET` works too, for Vercel Cron) with `Authorization: Bearer <CRON_SECRET>`.

## The jobs

| Job | Every | What it does |
| --- | --- | --- |
| `reap-generations` | 5 min | AI calls still running after 10 min (the function was killed) → failed; their reserved credits are released and the answer/Ask they were writing is marked failed, so the UI offers a retry. |
| `reap-ask-messages` | 5 min | Ask answers still "writing" and queued questions still "answering" after 10 min → failed. |
| `send-emails` | 5 min | Notification emails that failed are sent again: after 5 min, 30 min, 2 h and 12 h (5 attempts in all). `notify()` still sends at once; this only retries. The share-created email isn't retried (it carries the live share link, which is never stored). |
| `orphan-attachments` | hour | Unfinished uploads (> 1 h), uploads never sent with a message nor added as a document (> 24 h), and data-export ZIPs after their 24-hour download window: file deleted, then the row marked. |
| `expire-ownership-transfers` | hour | Pending transfers past their date → expired; the sender gets an in-app notice ("Ownership transfer expired"). |
| `run-alerts` | hour | `runAlertChecks()` (Step 10.2). |
| `expire-invites-shares` | day | Pending invitations past their date → expired. (Share links have no stored status: their expiry is read from the date.) |
| `purge-deleted` | day | Workspaces, projects and responses deleted more than 30 days ago are erased with their files (Privacy Policy: "permanently deleted … 30 days later"). A deleted project's workspaces stay (they were never deleted with it); they lose the project link. |
| `delete-accounts` | day | Erases accounts whose 30-day restore period has ended (`purgeDueAccounts()`, Step 9.5). |
| `enforce-member-limits` | day | Owners whose 14-day over-limit grace has ended: extra collaborators suspended and told (`enforceEndedGrace()`). |
| `refresh-credit-periods` | day | `ensureCurrentGrant()` for every account on a paid allowance: credits of ended plans expire and yearly subscribers get their monthly allowance, even if they never come back. |
| `purge-support-screenshots` | day | Support screenshots older than 90 days (Privacy Policy). |
| `purge-speech-cache` | day | Read-aloud audio not played for 90 days (a replay just generates it again). |
| `reconcile-billing` | day | Compares live subscriptions with Creem and reports differences (missed webhooks) in the logs and the `billing_drift` alert. Detects only; an admin fixes (`ADMIN_CONSOLE.md` §23). Does nothing while billing isn't configured. |
| `prune-job-runs` | day | Job history older than 30 days. |

Not built from the guide: `reconcile-usage` (there is no `UsageDaily` table to reconcile: the usage pages read the credit ledger directly, Step 9.3).

**Safety.** Every job is idempotent (running it twice gives the same result) and handles a batch per run (`more: true` in its result when it stopped early; the next run carries on). Each holds a lease in `job_locks`, so an overlapping run does nothing (`SKIPPED`); the lease frees itself after 6 minutes if the function was killed. Every run is recorded in `job_runs` with counts only; failures go to the logs and Sentry, and the alerts email you about failed, unfinished and overdue jobs.

## Setting up the scheduler (owner, once per environment)

The scheduler is the GitHub Actions workflow `.github/workflows/cron.yml` (Vercel Hobby only runs cron jobs once a day). It calls the 5-minute group, the hourly group and the daily group (03:23 UTC) on each environment you configure. Scheduled workflows only run from the **default branch** (`dev`), so nothing runs until this PR is merged.

1. **Make a secret per environment.** On your computer run `openssl rand -base64 48` twice: one value for production, one for preview. Never paste them in chat or commit them.
2. **Vercel** (Project → Settings → Environment Variables): add `CRON_SECRET`
   - Production: the production value.
   - Preview: the preview value (scope it to the `dev` branch if you can).

   Redeploy so the new variable is used (Deployments → … → Redeploy).
3. **GitHub** (repository `vyraxity/klecx` → Settings → Secrets and variables → Actions):
   - **Variables** tab → New repository variable: `CRON_BASE_URL` = `https://klecx.com`; `CRON_PREVIEW_BASE_URL` = `https://dev.klecx.com` (optional).
   - **Secrets** tab → New repository secret: `CRON_SECRET` = the production value; `CRON_PREVIEW_SECRET` = the preview value.
   - Leave an environment's variable empty to skip it (e.g. production before launch).
4. **Deployment protection.** While production (or preview) is behind Vercel's deployment protection, the scheduler's calls are stopped before they reach Klecx. Vercel: Project → Settings → Deployment Protection → **Protection Bypass for Automation** → create a secret (the label may differ; if your plan doesn't offer it, configure only the environments that aren't protected). Put it in GitHub as the secret `VERCEL_AUTOMATION_BYPASS_SECRET`; the workflow sends it as `x-vercel-protection-bypass`.
5. **Synthetic sign-in (optional, recommended).** Create a normal Klecx account for monitoring (an address you control, a long unique password, two-factor **off**, email verified), turn off its "new sign-in" emails in Settings → Notifications, then add the GitHub secrets `SYNTHETIC_EMAIL` and `SYNTHETIC_PASSWORD`. Every hour the workflow signs in on `CRON_BASE_URL`, calls `/api/v1/me` and signs out.
6. **Check it works:** GitHub → Actions → **cron** → **Run workflow** → group `frequent`. Each line of the log should read `HTTP 200 SUCCEEDED` (or `SKIPPED`). `HTTP 401` = the secret in GitHub differs from the one in Vercel (or Vercel wasn't redeployed); `HTTP 404` on every job = an old deployment without this step; a protection page = step 4. Then run `daily` and `hourly` once the same way.

**When something fails**, GitHub emails the person who last edited the workflow's schedule, and the failed job raises a `job_failed` alert (to `ALERTS_EMAIL`) at the next hourly check. Logs: Vercel → Logs, search `job failed` or the job's name.

## Limits to know

- GitHub's shortest schedule is every 5 minutes and runs can start several minutes late. That's fine: the 5-minute jobs only clean up and retry.
- In a **public** repository, GitHub turns scheduled workflows off after **60 days without commits**: Actions → cron → "Enable workflow". The `job_overdue` alert (and the uptime monitors) tell you if jobs stop.
- In a **private** repository, Actions minutes count against the free 2,000 a month, and the 5-minute schedule alone is about 8,600 runs a month. **Before making the repository private**, move the schedule to **Vercel Cron on Pro** (below), or to an external cron service calling the same URLs.
- The logs of a public repository's workflows are public: the workflow prints only the HTTP status and `SUCCEEDED`/`FAILED`, never the counts.

## Moving to Vercel Cron (Pro) later

Add to `vercel.json` (Vercel sends `Authorization: Bearer $CRON_SECRET` by itself and calls with GET):

```json
{
  "crons": [
    { "path": "/api/cron/reap-generations", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/run-alerts", "schedule": "7 * * * *" },
    { "path": "/api/cron/purge-deleted", "schedule": "23 3 * * *" }
  ]
}
```

…one entry per job of `lib/jobs/schedules.ts`, then delete `.github/workflows/cron.yml` (keep the synthetic sign-in somewhere else, e.g. an uptime service's keyword check) and update the test `schedules` in `__tests__/step-10-3-background-jobs.test.ts`.
