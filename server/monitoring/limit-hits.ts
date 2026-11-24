import "server-only";
import { db } from "@/server/db/client";

export type LimitKind = "DAILY_CREDIT_CAP" | "CONCURRENCY" | "SEARCH_CAP" | "VOICE_CAP" | "READ_ALOUD_CAP";

/**
 * Step 10.2: counts a refusal (or a search turned off) because a plan limit
 * was reached, per person, kind and UTC day. Not awaited by callers that are
 * about to throw: a failed count must never change what the person sees.
 */
export async function recordLimitHit(userId: string, kind: LimitKind, now: Date = new Date()): Promise<void> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  try {
    await db.usageLimitHit.upsert({
      where: { userId_kind_day: { userId, kind, day } },
      create: { userId, kind, day, firstAt: now, lastAt: now },
      update: { count: { increment: 1 }, lastAt: now },
    });
  } catch {
    // Monitoring only.
  }
}
