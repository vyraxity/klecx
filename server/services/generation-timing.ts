import "server-only";
import { db } from "@/server/db/client";

/**
 * Step 10.2 — time to first token. Returns a function to call on every text
 * chunk: the first call records `Generation.firstTokenAt` (one conditional
 * update, not awaited, never fails the stream); later calls do nothing.
 */
export function firstTokenMarker(generationId: string): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void db.generation
      .updateMany({ where: { id: generationId, firstTokenAt: null }, data: { firstTokenAt: new Date() } })
      .catch(() => undefined);
  };
}
