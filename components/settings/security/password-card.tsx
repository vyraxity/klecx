"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { SettingsSection } from "@/components/settings/settings-section";
import { api } from "@/lib/api/client";
import { authClient } from "@/lib/auth-client";
import { getApiErrorMessage } from "@/lib/api/error-message";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/schemas/account-security";

/**
 * Step 9.1: change the password (the current one is required; other devices
 * are signed out). An account without a password (Google/GitHub only) can set
 * one through the reset link sent to its own address.
 */
export function PasswordCard({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const t = useTranslations("Settings.security");
  const tRoot = useTranslations();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [linkSent, setLinkSent] = React.useState(false);

  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    current.length > 0 && next.length >= PASSWORD_MIN_LENGTH && next === confirm && !saving;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await api<{ revokedSessions: number }>("/api/v1/me/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      toast.success(t("passwordChanged", { count: res.revokedSessions }));
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("passwordChangeError")));
    } finally {
      setSaving(false);
    }
  };

  const sendSetLink = async () => {
    setSaving(true);
    try {
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: "/auth/reset-password",
      });
      if (error?.status === 429) {
        toast.error(tRoot("Errors.api.rate_limited"));
        return;
      }
      setLinkSent(true);
    } catch {
      toast.error(t("setPasswordError"));
    } finally {
      setSaving(false);
    }
  };

  if (!hasPassword) {
    return (
      <SettingsSection title={t("passwordTitle")} description={t("noPasswordHint")} data-testid="settings-password">
        {linkSent ? (
          <p role="status" className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-fg">
            {t("setPasswordSent", { email })}
          </p>
        ) : (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={sendSetLink} disabled={saving}>
              {saving && <Spinner size="sm" />}
              {t("setPassword")}
            </Button>
          </div>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("passwordTitle")} description={t("passwordHint")} data-testid="settings-password">
      <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-current-password">{t("currentPassword")}</Label>
          <Input
            id="settings-current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            maxLength={PASSWORD_MAX_LENGTH}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-new-password">{t("newPassword")}</Label>
          <Input
            id="settings-new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            maxLength={PASSWORD_MAX_LENGTH}
            aria-invalid={tooShort || undefined}
            aria-describedby="settings-new-password-hint"
            onChange={(e) => setNext(e.target.value)}
          />
          <p id="settings-new-password-hint" className="text-xs text-muted">
            {t("passwordRule", { min: PASSWORD_MIN_LENGTH })}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-confirm-password">{t("confirmPassword")}</Label>
          <Input
            id="settings-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            maxLength={PASSWORD_MAX_LENGTH}
            aria-invalid={mismatch || undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && (
            <p className="text-xs text-danger" role="alert">
              {t("passwordMismatch")}
            </p>
          )}
        </div>
        <div>
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {saving && <Spinner size="sm" />}
            {t("changePassword")}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
