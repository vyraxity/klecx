import "server-only";
import { purgeDueAccounts } from "@/server/services/account-deletion";
import { runAlertChecks } from "@/server/monitoring/alerts";
import { reapStuckAskMessages, reapStuckGenerations } from "./reap";
import { sendPendingEmails } from "./emails";
import { expireInvitesAndShares, expireOwnershipTransfers } from "./expiry";
import {
  cleanOrphanAttachments,
  purgeDeletedContent,
  purgeSpeechCache,
  purgeSupportScreenshots,
  pruneJobRuns,
} from "./cleanup";
import { enforceMemberLimits, reconcileBilling, refreshCreditPeriods } from "./billing";
import { runWithLock, type JobResult, type JobRunOutcome } from "./runner";
import { JOB_SCHEDULES, isJobName, type JobName } from "@/lib/jobs/schedules";

export { JOB_SCHEDULES, isJobName, type JobName };

/**
 * Step 10.3: every background job. The schedules (and which scheduler group
 * runs each) are in `lib/jobs/schedules.ts`; the workflow
 * `.github/workflows/cron.yml` calls them. Guide jobs not built:
 * `reconcile-usage` (there is no `UsageDaily` rollup: the usage pages read
 * the ledger directly, Step 9.3).
 */
const JOBS: Record<JobName, (now: Date) => Promise<JobResult>> = {
  "reap-generations": (now) => reapStuckGenerations(now),
  "reap-ask-messages": (now) => reapStuckAskMessages(now),
  "send-emails": (now) => sendPendingEmails(now),
  "orphan-attachments": (now) => cleanOrphanAttachments(now),
  "expire-ownership-transfers": (now) => expireOwnershipTransfers(now),
  "run-alerts": async (now) => {
    const out = await runAlertChecks(now);
    return { firing: out.firing.length, emailed: out.emailed.length };
  },
  "expire-invites-shares": (now) => expireInvitesAndShares(now),
  "purge-deleted": (now) => purgeDeletedContent(now),
  "delete-accounts": async (now) => {
    const out = await purgeDueAccounts(now);
    return { purged: out.purged, failed: out.failed };
  },
  "enforce-member-limits": (now) => enforceMemberLimits(now),
  "refresh-credit-periods": (now) => refreshCreditPeriods(now),
  "purge-support-screenshots": (now) => purgeSupportScreenshots(now),
  "purge-speech-cache": (now) => purgeSpeechCache(now),
  "reconcile-billing": () => reconcileBilling(),
  "prune-job-runs": (now) => pruneJobRuns(now),
};

/** Runs one job by name (under its lease, recorded in `job_runs`). */
export function runJob(name: JobName, now: Date = new Date()): Promise<JobRunOutcome> {
  return runWithLock(name, () => JOBS[name](now));
}
