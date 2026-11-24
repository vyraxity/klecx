import "server-only";
import { db } from "@/server/db/client";
import { retryNotificationEmail } from "@/server/services/notify";
import type { JobResult } from "./runner";

const BATCH = 100;

/**
 * `send-emails` (Step 10.3): notification emails that failed (or whose inline
 * send never finished) are sent again with backoff (5 min, 30 min, 2 h,
 * 12 h; at most 5 attempts in all). `notify()` still sends at once; this job
 * only retries. Each row is claimed before sending, so overlapping runs never
 * send the same email twice.
 */
export async function sendPendingEmails(now: Date = new Date()): Promise<JobResult> {
  const due = await db.notification.findMany({
    where: { emailStatus: { in: ["FAILED", "PENDING"] }, emailNextAttemptAt: { lte: now } },
    select: { id: true },
    orderBy: { emailNextAttemptAt: "asc" },
    take: BATCH,
  });
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const n of due) {
    const status = await retryNotificationEmail(n.id, now);
    if (status === "SENT") sent++;
    else if (status === "FAILED") failed++;
    else skipped++;
  }
  return { due: due.length, sent, failed, skipped, more: due.length === BATCH };
}
