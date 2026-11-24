# Server Jobs

Step 10.3 background jobs, called by the scheduler through `POST /api/cron/<job>` (`app/api/cron/[job]/route.ts`, bearer `CRON_SECRET`). Owner setup and the job list: `docs/background-jobs.md`.

- `runner.ts` — lease lock (`job_locks`), run history (`job_runs`), failure handling.
- `registry.ts` — job name → function; schedules live in `lib/jobs/schedules.ts` (the workflow `.github/workflows/cron.yml` must match; a test checks it).
- `reap.ts`, `emails.ts`, `expiry.ts`, `cleanup.ts`, `billing.ts` — the jobs. Each is idempotent, bounded per run, and returns counts only.
