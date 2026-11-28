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
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { getApiErrorMessage } from "@/lib/api/error-message";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SET_PASSWORD_CODE_MINUTES,
} from "@/lib/schemas/account-security";

/**
 * Step 9.1: change the password (the current one is required; other devices
 * are signed out). An account without a password (Google/GitHub only) adds one
 * here, confirmed with a 6-digit code emailed to it (pre-10.6 fix; it used to
 * get a reset link, which signed-in people couldn't open).
 */
export function PasswordCard({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const t = useTranslations("Settings.security");
  const tRoot = useTranslations();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [saving, setSaving] = React.useState(false);

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

  if (!hasPassword) {
    return <SetPasswordForm email={email} />;
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

/**
 * Pre-10.6 fix: add a password to an account that signs in with Google or
 * GitHub. 1) the new password, twice; 2) the 6-digit code emailed to the
 * account. Nothing changes until the code is confirmed.
 */
function SetPasswordForm({ email }: { email: string }) {
  const t = useTranslations("Settings.security");
  const tRoot = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [code, setCode] = React.useState("");
  const [step, setStep] = React.useState<"password" | "code">("password");
  const [busy, setBusy] = React.useState(false);
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const codeRef = React.useRef<HTMLInputElement>(null);

  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;
  const passwordReady = next.length >= PASSWORD_MIN_LENGTH && next === confirm;

  const sendCode = async () => {
    if (!passwordReady || busy) return;
    setBusy(true);
    setCodeError(null);
    try {
      await api("/api/v1/me/password/set/start", { method: "POST" });
      setStep("code");
      setCode("");
      toast.success(t("setPasswordCodeSent", { email }));
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("setPasswordError")));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === "password") {
      await sendCode();
      return;
    }
    if (!/^\d{6}$/.test(code) || busy) return;
    setBusy(true);
    setCodeError(null);
    try {
      await api("/api/v1/me/password/set/confirm", {
        method: "POST",
        body: { code, newPassword: next },
      });
      toast.success(t("passwordSet"));
      // The page now shows "Change password" and the email sign-in method.
      await queryClient.invalidateQueries({
        predicate: (q) => q.queryKey.includes("linked-accounts"),
      });
      router.refresh();
    } catch (err) {
      const message = getApiErrorMessage(err, tRoot, t("setPasswordError"));
      const errorCode = (err as { code?: string })?.code;
      if (errorCode === "code_expired" || errorCode === "code_attempts_exceeded") {
        // That code can't be used any more: back to sending a new one.
        setCode("");
      }
      setCodeError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t("passwordTitle")} description={t("noPasswordHint")} data-testid="settings-password">
      <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-set-password">{t("newPassword")}</Label>
          <Input
            id="settings-set-password"
            type="password"
            autoComplete="new-password"
            value={next}
            maxLength={PASSWORD_MAX_LENGTH}
            disabled={step === "code"}
            aria-invalid={tooShort || undefined}
            aria-describedby="settings-set-password-hint"
            onChange={(e) => setNext(e.target.value)}
          />
          <p id="settings-set-password-hint" className="text-xs text-muted">
            {t("passwordRule", { min: PASSWORD_MIN_LENGTH })}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-set-password-confirm">{t("confirmPassword")}</Label>
          <Input
            id="settings-set-password-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            maxLength={PASSWORD_MAX_LENGTH}
            disabled={step === "code"}
            aria-invalid={mismatch || undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && (
            <p className="text-xs text-danger" role="alert">
              {t("passwordMismatch")}
            </p>
          )}
        </div>

        {step === "code" && (
          <div className="flex flex-col gap-1.5">
            <p role="status" className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-fg">
              {t("setPasswordCodeHint", { email, minutes: SET_PASSWORD_CODE_MINUTES })}
            </p>
            <Label htmlFor="settings-set-password-code">{t("setPasswordCodeLabel")}</Label>
            <Input
              ref={codeRef}
              id="settings-set-password-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              aria-invalid={codeError ? true : undefined}
              aria-describedby={codeError ? "settings-set-password-code-error" : undefined}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="max-w-40 font-mono tracking-widest"
            />
            {codeError && (
              <p id="settings-set-password-code-error" className="text-xs text-danger" role="alert">
                {codeError}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {step === "password" ? (
            <Button type="submit" size="sm" disabled={!passwordReady || busy}>
              {busy && <Spinner size="sm" />}
              {t("setPasswordSendCode")}
            </Button>
          ) : (
            <>
              <Button type="submit" size="sm" disabled={code.length !== 6 || busy}>
                {busy && <Spinner size="sm" />}
                {t("setPasswordConfirm")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={sendCode} disabled={busy}>
                {t("setPasswordResend")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setStep("password");
                  setCode("");
                  setCodeError(null);
                }}
              >
                {t("setPasswordBack")}
              </Button>
            </>
          )}
        </div>
      </form>
    </SettingsSection>
  );
}
