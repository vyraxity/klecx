import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { Errors } from "@/server/http/errors";

const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();

/**
 * Step 10.3: the scheduler's `Authorization: Bearer <CRON_SECRET>`. Compared
 * in constant time (on digests, so lengths don't leak). With no
 * `CRON_SECRET` configured, every call is refused.
 */
export function authorizeCron(header: string | null, secret: string | null | undefined = env.CRON_SECRET): void {
  const given = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!secret || !given || !timingSafeEqual(digest(given), digest(secret))) {
    throw Errors.unauthorized();
  }
}
