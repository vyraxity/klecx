/**
 * Step 10.3: the background jobs and how often each runs. The scheduler
 * (`.github/workflows/cron.yml` today; Vercel Cron on Pro later) calls every
 * job of a group at that group's interval. `alerts.ts` uses the intervals to
 * spot overdue jobs, so keep the workflow's cron lines in step with this.
 */
export const JOB_GROUPS = {
  /** Every 5 minutes (GitHub's shortest schedule; runs can start late). */
  frequent: 5,
  hourly: 60,
  daily: 24 * 60,
} as const;

export type JobGroup = keyof typeof JOB_GROUPS;

export const JOB_SCHEDULES = {
  "reap-generations": "frequent",
  "reap-ask-messages": "frequent",
  "send-emails": "frequent",
  "orphan-attachments": "hourly",
  "expire-ownership-transfers": "hourly",
  "run-alerts": "hourly",
  "expire-invites-shares": "daily",
  "purge-deleted": "daily",
  "delete-accounts": "daily",
  "enforce-member-limits": "daily",
  "refresh-credit-periods": "daily",
  "purge-support-screenshots": "daily",
  "purge-speech-cache": "daily",
  "reconcile-billing": "daily",
  "prune-job-runs": "daily",
} as const satisfies Record<string, JobGroup>;

export type JobName = keyof typeof JOB_SCHEDULES;

export const JOB_NAMES = Object.keys(JOB_SCHEDULES) as JobName[];

export function isJobName(name: string): name is JobName {
  return Object.prototype.hasOwnProperty.call(JOB_SCHEDULES, name);
}

/** Minutes between two runs of a job. */
export function jobIntervalMinutes(name: JobName): number {
  return JOB_GROUPS[JOB_SCHEDULES[name]];
}
