"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { MailCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { SettingsSection } from "@/components/settings/settings-section";
import { api } from "@/lib/api/client";
import { getApiErrorMessage } from "@/lib/api/error-message";

/**
 * Step 9.1: email address and email change. The change takes two links: one
 * to the current address (approve), then one to the new address (verify).
 */
export function EmailCard({ email, justChanged }: { email: string; justChanged: boolean }) {
  const t = useTranslations("Settings.profilePage");
  const tRoot = useTranslations();
  const [editing, setEditing] = React.useState(false);
  const [newEmail, setNewEmail] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = newEmail.trim();
    if (!value) return;
    setSending(true);
    try {
      await api("/api/v1/me/email", { method: "POST", body: { newEmail: value } });
      setSentTo(value);
      setEditing(false);
      setNewEmail("");
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("emailChangeError")));
    } finally {
      setSending(false);
    }
  };

  return (
    <SettingsSection title={t("emailTitle")} description={t("emailHint")} data-testid="settings-email">
      {justChanged && (
        <p role="status" className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
          <MailCheck className="h-4 w-4 shrink-0" aria-hidden />
          {t("emailChanged")}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="break-all text-sm font-semibold text-fg">{email}</span>
        {!editing && (
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            {t("emailChange")}
          </Button>
        )}
      </div>
      {sentTo && (
        <p role="status" className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-fg">
          {t("emailChangeSent", { current: email, next: sentTo })}
        </p>
      )}
      {editing && (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <Label htmlFor="settings-new-email">{t("emailNewLabel")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="settings-new-email"
              type="email"
              autoComplete="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="sm:max-w-sm"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={sending || !newEmail.trim()}>
                {sending && <Spinner size="sm" />}
                {t("emailSendLink")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={sending}>
                {t("cancel")}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted">{t("emailChangeSteps")}</p>
        </form>
      )}
    </SettingsSection>
  );
}
