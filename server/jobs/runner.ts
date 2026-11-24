import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { log, errInfo } from "@/server/log";
import { captureServerError } from "@/server/monitoring/sentry";
import type { Prisma } from "@/server/db/generated/client";

/**
 * Step 10.3 — the background job runner.
 *
 * A scheduler (GitHub Actions at first, `.github/workflows/cron.yml`; Vercel
 * Cron later) calls `POST /api/cron/<job>` with `Authorization: Bearer
 * <CRON_SECRET>`; the route calls `runJob()`. Every job:
 *
 * - is **idempotent**: running it twice in a row gives the same state as once
 *   (each item is claimed with a conditional update, or the work it does is
 *   keyed), and **bounded**: it handles at most a batch per run, reports
 *   `more: true` when it stopped early, and the next run carries on;
 * - holds a **lease** (`job_locks`) while it runs, so an overlapping run (a
 *   slow run, a scheduler retry) does nothing and reports `skipped`. Not a
 *   Postgres session advisory lock (`pg_try_advisory_lock`, as the guide
 *   says): with a connection pool, the unlock can run on another connection
 *   and never release it. The lease expires by itself after
 *   `LEASE_MS` if the function is killed mid-run;
 * - is **recorded** in `job_runs` (status, counts, error code), which the
 *   alerts read (`server/monitoring/alerts.ts`: failed, unfinished and
 *   overdue jobs).
 *
 * Results hold counts only: never ids of people, emails or content (rule 11).
 */

/** Longer than a route may run (300 s, `vercel.json`), so a live run never loses its lease. */
export const LEASE_MS = 6 * 60_000;

export type JobResult = Record<string, number | boolean>;

export interface JobRunOutcome {
  job: string;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  result?: JobResult;
  errorCode?: string;
  ms: number;
}

/** Takes the job's lease; false when another run holds it. */
export async function acquireJobLock(job: string, holder: string, leaseMs = LEASE_MS): Promise<boolean> {
  const until = new Date(Date.now() + leaseMs);
  const rows = await db.$queryRaw<{ holder: string }[]>`
    INSERT INTO job_locks (job, locked_until, holder, updated_at)
    VALUES (${job}, ${until}, ${holder}, now())
    ON CONFLICT (job) DO UPDATE
      SET locked_until = EXCLUDED.locked_until, holder = EXCLUDED.holder, updated_at = now()
      WHERE job_locks.locked_until <= now()
    RETURNING holder`;
  return rows[0]?.holder === holder;
}

export async function releaseJobLock(job: string, holder: string): Promise<void> {
  await db.jobLock.updateMany({ where: { job, holder }, data: { lockedUntil: new Date(0) } });
}

/** A stable, log-safe error code (never the message, which could carry data). */
function errorCodeOf(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  if (typeof e?.code === "string" && /^[\w.:-]{1,60}$/.test(e.code)) return e.code;
  if (typeof e?.name === "string" && /^[\w.:-]{1,60}$/.test(e.name)) return e.name;
  return "error";
}

/**
 * Runs one job under its lease and records the run. Never throws: a failure
 * is returned (and logged, and sent to Sentry) as `status: "FAILED"`.
 */
export async function runWithLock(
  job: string,
  fn: () => Promise<JobResult>
): Promise<JobRunOutcome> {
  const started = Date.now();
  const holder = randomUUID();
  if (!(await acquireJobLock(job, holder))) {
    log.info({ job }, "job skipped: another run holds the lock");
    return { job, status: "SKIPPED", ms: Date.now() - started };
  }
  const run = await db.jobRun.create({ data: { job, status: "RUNNING" }, select: { id: true } });
  try {
    const result = await fn();
    // Some items failed (each is logged): the run counts as failed, so the alerts see it.
    const partial = typeof result.failed === "number" && result.failed > 0;
    const status = partial ? "FAILED" : "SUCCEEDED";
    const errorCode = partial ? "partial_failure" : undefined;
    await db.jobRun.update({
      where: { id: run.id },
      data: { status, finishedAt: new Date(), result: result as Prisma.InputJsonValue, errorCode },
    });
    const ms = Date.now() - started;
    if (partial) log.warn({ job, ms, result }, "job finished with failures");
    else log.info({ job, ms, result }, "job finished");
    return { job, status, result, ms, ...(errorCode ? { errorCode } : {}) };
  } catch (err) {
    const errorCode = errorCodeOf(err);
    await db.jobRun
      .update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode } })
      .catch(() => undefined);
    log.error({ job, err: errInfo(err) }, "job failed");
    captureServerError(err, { route: `cron:${job}` });
    return { job, status: "FAILED", errorCode, ms: Date.now() - started };
  } finally {
    await releaseJobLock(job, holder).catch(() => undefined);
  }
}
