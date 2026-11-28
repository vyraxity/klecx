import "server-only";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { log, errInfo } from "@/server/log";
import { ApiError, Errors } from "@/server/http/errors";
import type { Actor } from "@/server/auth/session";
import {
  AI_PAUSED_CODE,
  FEATURE_FLAG_CACHE_MS,
  FEATURE_KEYS,
  FEATURE_PAUSED_CODE,
  type FeatureKey,
  type FeatureStates,
} from "@/lib/features/flags";

/**
 * Step 10.6 feature switches (keys and rules: `lib/features/flags.ts`).
 * A feature is on unless `DISABLED_FEATURES` lists it or an admin paused it
 * (a `feature_flags` row). Runtime pauses are cached per instance for
 * `FEATURE_FLAG_CACHE_MS`; if the table can't be read, the last known pauses
 * stay in force (none before the first successful read).
 */

function requireAdmin(actor: Actor) {
  if (actor.role !== "ADMIN") throw Errors.forbidden("Admin role required");
}

interface PauseInfo {
  reason: string | null;
  updatedAt: Date;
}

let cache: { at: number; pauses: Map<FeatureKey, PauseInfo> } | null = null;
let inflight: Promise<Map<FeatureKey, PauseInfo>> | null = null;

// Jest workers share one database: under tests, runtime pauses are read only in a
// test file that opts in (`enableRuntimePausesForTesting`), so one file's pause can't
// leak into another file running at the same time.
let runtimeReads = process.env.NODE_ENV !== "test";

async function loadPauses(): Promise<Map<FeatureKey, PauseInfo>> {
  if (!runtimeReads) return new Map();
  if (cache && Date.now() - cache.at < FEATURE_FLAG_CACHE_MS) return cache.pauses;
  inflight ??= (async () => {
    try {
      const rows = await db.featureFlag.findMany();
      const pauses = new Map<FeatureKey, PauseInfo>();
      for (const row of rows) {
        if ((FEATURE_KEYS as readonly string[]).includes(row.key)) {
          pauses.set(row.key as FeatureKey, { reason: row.reason, updatedAt: row.updatedAt });
        }
      }
      cache = { at: Date.now(), pauses };
      return pauses;
    } catch (err) {
      log.warn({ err: errInfo(err) }, "feature flags: could not read runtime pauses");
      // Keep the last known pauses; retry on the next call.
      return cache?.pauses ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function disabledByEnv(key: FeatureKey): boolean {
  return env.DISABLED_FEATURES.includes(key);
}

/** Whether a feature is on right now (env and runtime pauses). */
export async function isFeatureOn(key: FeatureKey): Promise<boolean> {
  if (disabledByEnv(key)) return false;
  const pauses = await loadPauses();
  return !pauses.has(key);
}

/** Every feature's state, for `GET /api/v1/features` (booleans only). */
export async function getFeatureStates(): Promise<FeatureStates> {
  const pauses = await loadPauses();
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, !disabledByEnv(key) && !pauses.has(key)])
  ) as FeatureStates;
}

/** 503 for a paused feature: `ai_paused` for the kill switch, else `feature_paused` with the key. */
export function featurePausedError(key: FeatureKey): ApiError {
  return key === "ai"
    ? new ApiError(503, AI_PAUSED_CODE, "AI features are paused for now", { feature: key })
    : new ApiError(503, FEATURE_PAUSED_CODE, "This feature is paused for now", { feature: key });
}

/** Throws `featurePausedError()` when the feature is off. Call it before reserving credits. */
export async function assertFeature(key: FeatureKey): Promise<void> {
  if (!(await isFeatureOn(key))) throw featurePausedError(key);
}

/** An AI feature needs the kill switch and its own switch to be on. */
export async function assertAiFeature(key?: Exclude<FeatureKey, "ai">): Promise<void> {
  await assertFeature("ai");
  if (key) await assertFeature(key);
}

export interface AdminFeatureState {
  key: FeatureKey;
  /** What the app does now. */
  enabled: boolean;
  /** Off through `DISABLED_FEATURES`: an admin can't turn it on (change the variable and redeploy). */
  disabledByEnv: boolean;
  /** An admin's runtime pause, if any. */
  paused: { reason: string | null; since: string; byUserId: string | null } | null;
}

/** Admins: every feature with where its state comes from. Reads the table directly (no cache). */
export async function listFeatureFlags(actor: Actor): Promise<AdminFeatureState[]> {
  requireAdmin(actor);
  const rows = await db.featureFlag.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return FEATURE_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      enabled: !disabledByEnv(key) && !row,
      disabledByEnv: disabledByEnv(key),
      paused: row
        ? { reason: row.reason, since: row.updatedAt.toISOString(), byUserId: row.updatedById }
        : null,
    };
  });
}

/**
 * Admins: pause (`enabled: false`) or resume (`enabled: true`) a feature at runtime.
 * Applies at once on this instance and within `FEATURE_FLAG_CACHE_MS` on the others.
 * Resuming doesn't override `DISABLED_FEATURES`. Every change is written to `audit_logs`.
 */
export async function setFeatureFlag(
  actor: Actor,
  key: FeatureKey,
  input: { enabled: boolean; reason?: string }
): Promise<AdminFeatureState> {
  requireAdmin(actor);
  const reason = input.reason?.trim() || null;
  if (input.enabled) {
    await db.$transaction([
      db.featureFlag.deleteMany({ where: { key } }),
      db.auditLog.create({
        data: { userId: actor.userId, action: "FEATURE_RESUMED", targetId: key, metadata: reason ? { reason } : undefined },
      }),
    ]);
  } else {
    await db.$transaction([
      db.featureFlag.upsert({
        where: { key },
        create: { key, reason, updatedById: actor.userId },
        update: { reason, updatedById: actor.userId },
      }),
      db.auditLog.create({
        data: { userId: actor.userId, action: "FEATURE_PAUSED", targetId: key, metadata: reason ? { reason } : undefined },
      }),
    ]);
  }
  log.warn({ feature: key, enabled: input.enabled, adminId: actor.userId }, "feature flag changed");
  cache = null;
  const states = await listFeatureFlags(actor);
  return states.find((s) => s.key === key)!;
}

/** Tests: forget the cached runtime pauses. */
export function resetFeatureFlagCacheForTesting(): void {
  cache = null;
  inflight = null;
}

/** Tests: read runtime pauses from the database in this test file (off by default under Jest). */
export function enableRuntimePausesForTesting(on: boolean): void {
  runtimeReads = on;
  resetFeatureFlagCacheForTesting();
}
