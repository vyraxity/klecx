/**
 * What a billing webhook changed (Step 8.3), carried as `payload.kind` of a
 * `SUBSCRIPTION_CHANGED` notification. The bell and the email have one text per kind.
 */
export const SUBSCRIPTION_CHANGE_KINDS = [
  "activated",
  "payment_received",
  "cancel_scheduled",
  "ended",
  "paused",
  "refunded",
  "refunded_partial",
  "disputed",
] as const;

export type SubscriptionChangeKind = (typeof SUBSCRIPTION_CHANGE_KINDS)[number];

export function isSubscriptionChangeKind(value: unknown): value is SubscriptionChangeKind {
  return typeof value === "string" && (SUBSCRIPTION_CHANGE_KINDS as readonly string[]).includes(value);
}
