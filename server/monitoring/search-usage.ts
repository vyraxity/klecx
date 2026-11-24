import "server-only";
import { db } from "@/server/db/client";

/**
 * Grounded web-search requests Klecx sent to the provider in [from, to), and
 * the queries the provider ran for them (fix before Step 10.3). Read from
 * `generations.usage` (`searches`, `searchQueries`); rows from before the
 * fix have no `searchQueries`: one query per search.
 */
export async function countSearchRequests(from: Date, to: Date): Promise<{ requests: number; queries: number }> {
  const rows = await db.$queryRaw<{ requests: bigint | number | null; queries: bigint | number | null }[]>`
    SELECT
      COALESCE(SUM((usage->>'searches')::int), 0) AS requests,
      COALESCE(SUM(COALESCE((usage->>'searchQueries')::int, (usage->>'searches')::int)), 0) AS queries
    FROM generations
    WHERE created_at >= ${from} AND created_at < ${to}
      AND jsonb_typeof(usage->'searches') = 'number'`;
  return { requests: Number(rows[0]?.requests ?? 0), queries: Number(rows[0]?.queries ?? 0) };
}

export const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const startOfUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
