import "server-only";
import { db } from "@/server/db/client";
import { log, errInfo } from "@/server/log";
import { release } from "@/server/services/credits";
import type { JobResult } from "./runner";

/**
 * Step 10.3 — crash recovery (guide §2.x, `reap-generations` and
 * `reap-ask-messages`). An AI call whose function was killed (deploy, crash,
 * time limit) stays RUNNING and keeps its credits reserved. After
 * `STUCK_AFTER_MS` (longer than any route may run: 300 s) it is marked
 * FAILED and its reservation released; what it was writing (a response
 * version, an Ask answer, queued questions) is marked failed too, so the UI
 * offers a retry. Nobody is notified.
 */
export const STUCK_AFTER_MS = 10 * 60_000;
const BATCH = 200;

async function hasOpenReservation(accountId: string, generationId: string): Promise<boolean> {
  const rows = await db.creditLedger.findMany({
    where: { accountId, generationId, type: { in: ["RESERVE", "SETTLE", "RELEASE"] } },
    select: { type: true },
  });
  return rows.some((r) => r.type === "RESERVE") && !rows.some((r) => r.type !== "RESERVE");
}

/** `reap-generations`: RUNNING (or never-started QUEUED) calls older than 10 min → FAILED, credits released. */
export async function reapStuckGenerations(now: Date = new Date()): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = await db.generation.findMany({
    where: {
      OR: [
        { status: "RUNNING", startedAt: { lt: cutoff } },
        { status: "RUNNING", startedAt: null, createdAt: { lt: cutoff } },
        { status: "QUEUED", createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true, billedAccountId: true, versionId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  let reaped = 0;
  let released = 0;
  let failed = 0;
  for (const gen of stuck) {
    try {
      // Release first (idempotent: the same key as a normal release), then
      // mark: if the release fails, the call stays RUNNING and the next run retries.
      if (await hasOpenReservation(gen.billedAccountId, gen.id)) {
        await release(gen.billedAccountId, gen.id);
        released++;
      }
      const marked = await db.generation.updateMany({
        where: { id: gen.id, status: { in: ["RUNNING", "QUEUED"] } },
        data: { status: "FAILED", errorCode: "timeout_orphaned", finishedAt: now },
      });
      if (marked.count === 0) continue; // finished meanwhile
      reaped++;
      if (gen.versionId) {
        await db.responseVersion.updateMany({
          where: { id: gen.versionId, status: "STREAMING" },
          data: { status: "FAILED" },
        });
      }
      await db.annotationMessage.updateMany({
        where: { generationId: gen.id, status: "STREAMING" },
        data: { status: "FAILED" },
      });
    } catch (err) {
      failed++;
      log.error({ job: "reap-generations", err: errInfo(err) }, "could not reap a generation");
    }
  }
  return { found: stuck.length, reaped, released, failed, more: stuck.length === BATCH };
}

/**
 * `reap-ask-messages`: Ask answers still STREAMING and queued questions still
 * ANSWERING after 10 min → FAILED (their generation, and its credits, are
 * handled by `reap-generations`). Covers rows whose generation was already
 * closed, or that never got one.
 */
export async function reapStuckAskMessages(now: Date = new Date()): Promise<JobResult> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const messages = await db.annotationMessage.updateMany({
    where: { status: "STREAMING", createdAt: { lt: cutoff } },
    data: { status: "FAILED" },
  });
  const questions = await db.annotation.updateMany({
    where: { questionState: "ANSWERING", updatedAt: { lt: cutoff } },
    data: { questionState: "FAILED" },
  });
  return { messages: messages.count, questions: questions.count };
}
