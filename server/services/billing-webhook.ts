import "server-only";
import { log, errInfo } from "@/server/log";
import { db } from "@/server/db/client";
import { getSiteConfig } from "@/server/config/site";
import { sendEmail } from "@/server/email/send";
import { getBillingProvider } from "@/server/billing/get-provider";
import { applyBillingEvent, type Effect, type EventOutcome } from "@/server/billing/handlers";
import {
  BillingProviderError,
  WebhookSignatureError,
  type BillingProvider,
  type NormalizedEvent,
} from "@/server/billing/provider";
import { notify } from "@/server/services/notify";
import { applyMemberLimitForPlanChange } from "@/server/services/member-limits";
import type { Prisma } from "@/server/db/generated/client";

/**
 * Provider webhooks (Step 8.3): verify the signature on the raw body, store the
 * event once (`BillingEvent`, unique per provider event id), apply it in one
 * transaction, then run its side effects.
 *
 * Answers: 401 bad/missing signature (nothing written); 200 applied, ignored or
 * already done; 500 the handler failed (the row is FAILED and the provider's
 * retry runs it again); 503 billing isn't configured here.
 *
 * A delivery locks its event row, so a retry that arrives while the first
 * delivery is still running waits and then sees it PROCESSED.
 */

export type WebhookResult = { status: number; body: string };

const DONE = new Set(["PROCESSED", "IGNORED"]);
/** Creem waits 15 s for an answer. */
const TX_TIMEOUT_MS = 12_000;

export async function handleBillingWebhook(
  rawBody: string,
  signature: string | null,
  requestId: string
): Promise<WebhookResult> {
  const provider = getBillingProvider();
  if (!provider) {
    log.error({ requestId, billing: "webhook", err: "billing provider not configured" });
    return { status: 503, body: "billing unavailable" };
  }

  let event: NormalizedEvent;
  try {
    event = provider.verifyWebhook(rawBody, signature);
  } catch (e) {
    if (e instanceof WebhookSignatureError) {
      log.warn({ requestId, billing: "webhook", err: "invalid signature" });
      return { status: 401, body: "invalid signature" };
    }
    if (e instanceof BillingProviderError) {
      log.error({ requestId, billing: "webhook", err: errInfo(e) });
      return { status: 503, body: "billing unavailable" };
    }
    throw e;
  }

  const fields = { requestId, billing: "webhook", provider: event.provider, eventId: event.id, type: event.type };

  try {
    await db.billingEvent.createMany({
      data: [
        {
          provider: event.provider,
          providerEventId: event.id,
          type: event.type,
          payload: event.payload as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });

    const outcome = await db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id, status FROM billing_events
          WHERE provider = ${event.provider} AND provider_event_id = ${event.id}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new Error("billing event row missing");
        if (DONE.has(row.status)) return null;

        const result = await applyBillingEvent(tx, event, provider);
        await tx.billingEvent.update({
          where: { id: row.id },
          data: {
            status: result.status,
            userId: result.userId,
            error: result.note,
            processedAt: new Date(),
          },
        });
        return result;
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 5_000 }
    );

    if (!outcome) {
      log.info({ ...fields, outcome: "duplicate" });
      return { status: 200, body: "ok" };
    }
    log.info({ ...fields, outcome: outcome.status, note: outcome.note });
    await runEffects(outcome, event, provider, fields);
    return { status: 200, body: "ok" };
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
    log.error({ ...fields, err: message });
    await db.billingEvent
      .updateMany({
        where: { provider: event.provider, providerEventId: event.id, status: { notIn: [...DONE] } },
        data: { status: "FAILED", error: message.slice(0, 500) },
      })
      .catch(() => {});
    return { status: 500, body: "retry" };
  }
}

/** Side effects after the commit. Each one is independent; a failure is logged and never fails the webhook. */
async function runEffects(
  outcome: EventOutcome,
  event: NormalizedEvent,
  provider: BillingProvider,
  fields: Record<string, unknown>
): Promise<void> {
  for (const effect of outcome.effects) {
    try {
      await runEffect(effect, event, provider);
    } catch (e) {
      log.error({ ...fields, effect: effect.kind, err: errInfo(e) });
    }
  }
}

async function runEffect(effect: Effect, event: NormalizedEvent, provider: BillingProvider): Promise<void> {
  switch (effect.kind) {
    case "notify":
      await notify(effect.userId, effect.type, effect.payload, { dedupeKey: effect.dedupeKey });
      return;

    case "planChanged":
      // Collaborator limits follow the owner's plan (F1.3).
      await applyMemberLimitForPlanChange(effect.userId, effect.before, effect.after);
      return;

    case "cancelNow":
      try {
        await provider.cancelSubscription(effect.subscriptionId, { atPeriodEnd: false });
      } catch (e) {
        // The plan already ended here; support finishes it at the provider.
        await sendAlert(event, "refund_cancel_failed", effect.userId);
        throw e;
      }
      return;

    case "alert":
      await sendAlert(event, effect.reason, effect.userId);
      return;
  }
}

/** Emails the billing inbox. Ids only: no payload, amounts or personal data. */
async function sendAlert(event: NormalizedEvent, reason: string, userId: string | null): Promise<void> {
  const site = getSiteConfig();
  await sendEmail("billing-alert", site.emails.billing, {
    reason,
    eventType: event.type,
    eventId: event.id,
    userId,
  });
}
