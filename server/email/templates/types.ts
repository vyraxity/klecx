import "server-only";
import type { SubscriptionChangeKind } from "@/lib/billing/subscription-changes";

export type EmailTranslator = (
  key: string,
  values?: Record<string, unknown>
) => string;

export interface EmailTemplateResult {
  subject: string;
  html: string;
  text: string;
}

export interface VerifyEmailData {
  url: string;
  name?: string;
}

export interface ResetPasswordData {
  url: string;
  name?: string;
}

export interface InvitationData {
  inviterName: string;
  teamOrProjectName: string;
  inviteUrl: string;
  role?: string;
}

export interface NewSignInData {
  time: string;
  /** ISO time; when present the email formats it in the reader's language. */
  timeIso?: string;
  browser?: string | null;
  os?: string | null;
  /** A device name set by the person or a phone's model (language-neutral). */
  customDevice?: string | null;
  /** English label, kept for older notifications. */
  device?: string;
  ipAddress?: string;
  location?: string;
}

export interface ChangeEmailConfirmData {
  url: string;
  newEmail: string;
}

export interface ChangeEmailVerifyData {
  url: string;
}

export interface PasswordChangedData {
  time: string;
}

export interface ShareCreatedData {
  title: string;
  shareUrl: string;
}

export interface CreditsLowData {
  remainingCredits: number;
  upgradeUrl: string;
}

export interface PaymentFailedData {
  reason?: string;
  retryUrl: string;
}

export interface SupportAckData {
  ticketId: string;
  topic: string;
  message: string;
  name?: string;
  /** Screenshots stored with the request (F5.8). */
  screenshotCount?: number;
}

export interface SupportNotificationData {
  ticketId: string;
  senderEmail: string;
  topic: string;
  message: string;
  diagnostics?: string;
  userId?: string;
  /** Signed links to the request's screenshots, valid for 7 days (F5.8). */
  screenshotLinks?: string[];
  /** Billing requests from a subscriber: the refund policy check (Step 8.4). */
  refundEligibility?: {
    eligible: boolean;
    rule: string | null;
    creditsUsedPct: number | null;
    daysSincePayment: number | null;
    paymentNumber: number;
    previousRefunds: number;
  };
}

export interface OwnershipTransferRequestedData {
  fromUserName: string;
  resourceName: string;
  acceptUrl: string;
  expiresInDays?: number;
}

export interface OwnershipTransferAcceptedData {
  toUserName: string;
  resourceName: string;
  actionUrl?: string;
  previousOwnerAction?: "STAY_ADMIN" | "LEAVE";
}

export interface MemberLimitExceededData {
  limit: number;
  graceEndsAt: string;
  manageUrl: string;
}

export interface MemberSuspendedData {
  resourceName: string;
  reason?: string;
  actionUrl?: string;
}

export interface MemberRestoredData {
  resourceName: string;
  actionUrl?: string;
}

export interface MentionedData {
  authorName: string;
  quote?: string;
  excerpt: string;
  actionUrl?: string;
}

export interface WelcomeEmailData {
  name?: string;
}


export interface SubscriptionChangedData {
  kind: SubscriptionChangeKind;
  /** ISO date the paid plan ends (`cancel_scheduled`). */
  periodEnd?: string | null;
  actionUrl: string;
}

/** Step 8.3: internal alert to the billing inbox. Ids only. */
export interface BillingAlertData {
  reason: string;
  eventType: string;
  eventId: string;
  userId: string | null;
}

/** Step 9.5: Settings → Your data. */
export interface DataExportReadyData {
  hours: number;
}

export interface AccountDeletionScheduledData {
  /** ISO date when the account is erased. */
  purgeAfter: string;
  restoreUrl: string;
}

export type AccountRestoredData = Record<string, never>;

export interface EmailTemplateMap {
  "verify-email": VerifyEmailData;
  "reset-password": ResetPasswordData;
  welcome: WelcomeEmailData;
  invitation: InvitationData;
  "new-sign-in": NewSignInData;
  "password-changed": PasswordChangedData;
  "change-email-confirm": ChangeEmailConfirmData;
  "change-email-verify": ChangeEmailVerifyData;
  "share-created": ShareCreatedData;
  "credits-low": CreditsLowData;
  "payment-failed": PaymentFailedData;
  "support-ack": SupportAckData;
  "support-notification": SupportNotificationData;
  "ownership-transfer-requested": OwnershipTransferRequestedData;
  "ownership-transfer-accepted": OwnershipTransferAcceptedData;
  "member-limit-exceeded": MemberLimitExceededData;
  "member-suspended": MemberSuspendedData;
  "member-restored": MemberRestoredData;
  mentioned: MentionedData;
  "subscription-changed": SubscriptionChangedData;
  "billing-alert": BillingAlertData;
  "data-export-ready": DataExportReadyData;
  "account-deletion-scheduled": AccountDeletionScheduledData;
  "account-restored": AccountRestoredData;
}

export type EmailTemplateName = keyof EmailTemplateMap;
