"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { CopyButton } from "@/components/ui/copy-button";
import { SettingsSection } from "@/components/settings/settings-section";
import { QrCode } from "@/components/settings/security/qr-code";
import { api } from "@/lib/api/client";
import { getApiErrorMessage } from "@/lib/api/error-message";
import { PASSWORD_MAX_LENGTH } from "@/lib/schemas/account-security";
import { TOTP_CODE_LENGTH, normalizeTotpCode } from "@/lib/auth/two-factor";

type Status = { enabled: boolean; hasPassword: boolean };
type Setup = { totpUri: string; manualKey: string; backupCodes: string[] };

/**
 * What the card shows:
 * - `idle`: status and buttons;
 * - `password`: the password before an action (`pending` says which);
 * - `scan`: QR code + manual key + the first code (turning on);
 * - `codes`: backup codes to save (after turning on or making new ones).
 */
type Step =
  | { name: "idle" }
  | { name: "password"; pending: "setup" | "backupCodes" | "disable" }
  | { name: "scan"; setup: Setup }
  | { name: "codes"; codes: string[] };

/**
 * Two-factor sign-in (after Step 10.1): Settings → Security. Turning it on is
 * password → scan the QR code → first code → save the backup codes. Turning it
 * off and making new backup codes need the password too. The server also emails
 * the person after every change.
 */
export function TwoFactorCard({ initial }: { initial: Status }) {
  const t = useTranslations("Settings.security.twoFactor");
  const tRoot = useTranslations();
  const [status, setStatus] = React.useState<Status>(initial);
  const [step, setStep] = React.useState<Step>({ name: "idle" });
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const headingRef = React.useRef<HTMLDivElement>(null);

  const go = (next: Step) => {
    setStep(next);
    setPassword("");
    setCode("");
    requestAnimationFrame(() => headingRef.current?.querySelector<HTMLElement>("input, button")?.focus());
  };

  const fail = (err: unknown, fallback: string) => toast.error(getApiErrorMessage(err, tRoot, fallback));

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.name !== "password" || !password || busy) return;
    setBusy(true);
    try {
      if (step.pending === "setup") {
        const setup = await api<Setup>("/api/v1/me/two-factor/setup", { method: "POST", body: { password } });
        go({ name: "scan", setup });
      } else if (step.pending === "backupCodes") {
        const res = await api<{ backupCodes: string[] }>("/api/v1/me/two-factor/backup-codes", {
          method: "POST",
          body: { password },
        });
        go({ name: "codes", codes: res.backupCodes });
      } else {
        const res = await api<Status>("/api/v1/me/two-factor/disable", { method: "POST", body: { password } });
        setStatus(res);
        toast.success(t("disabledToast"));
        go({ name: "idle" });
      }
    } catch (err) {
      fail(err, t("actionError"));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step.name !== "scan" || code.length !== TOTP_CODE_LENGTH || busy) return;
    setBusy(true);
    try {
      const res = await api<Status>("/api/v1/me/two-factor/confirm", { method: "POST", body: { code } });
      setStatus(res);
      toast.success(t("enabledToast"));
      go({ name: "codes", codes: step.setup.backupCodes });
    } catch (err) {
      fail(err, t("actionError"));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const downloadCodes = (codes: string[]) => {
    const text = `${t("codesFileHeader")}\n\n${codes.join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "klecx-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const description = !status.hasPassword && !status.enabled ? t("needsPassword") : t("hint");

  return (
    <SettingsSection
      title={t("title")}
      description={description}
      data-testid="settings-two-factor"
      actions={
        <span
          className={
            status.enabled
              ? "inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-semibold text-success"
              : "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-muted"
          }
        >
          {status.enabled ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <ShieldOff className="h-3.5 w-3.5" aria-hidden />}
          {status.enabled ? t("statusOn") : t("statusOff")}
        </span>
      }
    >
      <div ref={headingRef} className="flex flex-col gap-4">
        {step.name === "idle" && (
          <div className="flex flex-wrap gap-2">
            {status.enabled ? (
              <>
                <Button type="button" size="sm" variant="outline" onClick={() => go({ name: "password", pending: "backupCodes" })}>
                  {t("newBackupCodes")}
                </Button>
                <Button type="button" size="sm" variant="outline" className="text-danger" onClick={() => go({ name: "password", pending: "disable" })}>
                  {t("turnOff")}
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" disabled={!status.hasPassword} onClick={() => go({ name: "password", pending: "setup" })}>
                {t("turnOn")}
              </Button>
            )}
          </div>
        )}

        {step.name === "password" && (
          <form onSubmit={submitPassword} className="flex max-w-sm flex-col gap-3">
            <p className="text-xs text-muted">
              {step.pending === "setup" ? t("passwordForSetup") : step.pending === "disable" ? t("passwordForDisable") : t("passwordForCodes")}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="two-factor-password">{t("passwordLabel")}</Label>
              <Input
                id="two-factor-password"
                type="password"
                autoComplete="current-password"
                value={password}
                maxLength={PASSWORD_MAX_LENGTH}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={!password || busy} variant={step.pending === "disable" ? "destructive" : "default"}>
                {busy && <Spinner size="sm" />}
                {step.pending === "disable" ? t("turnOff") : t("continue")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => go({ name: "idle" })}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}

        {step.name === "scan" && (
          <form onSubmit={submitCode} className="flex flex-col gap-4">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-fg">
              <li>{t("scanStep1")}</li>
              <li>{t("scanStep2")}</li>
              <li>{t("scanStep3")}</li>
            </ol>
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <QrCode value={step.setup.totpUri} label={t("qrLabel")} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs text-muted">{t("manualKeyLabel")}</span>
                <div className="flex items-center gap-1">
                  <code className="break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-fg">{step.setup.manualKey}</code>
                  <CopyButton value={step.setup.manualKey.replace(/\s+/g, "")} label={t("copyKey")} />
                </div>
              </div>
            </div>
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="two-factor-setup-code">{t("codeLabel")}</Label>
              <Input
                id="two-factor-setup-code"
                value={code}
                onChange={(e) => setCode(normalizeTotpCode(e.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={TOTP_CODE_LENGTH}
                placeholder={t("codePlaceholder")}
                className="font-mono tracking-[0.3em]"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={code.length !== TOTP_CODE_LENGTH || busy}>
                {busy && <Spinner size="sm" />}
                {t("confirm")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => go({ name: "idle" })}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}

        {step.name === "codes" && (
          <div className="flex flex-col gap-3">
            <p role="status" className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-fg">
              {t("codesWarning")}
            </p>
            <ul aria-label={t("codesListLabel")} className="grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm text-fg">
              {step.codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={step.codes.join("\n")} label={t("copyCodes")} showText variant="outline" size="sm" />
              <Button type="button" size="sm" variant="outline" onClick={() => downloadCodes(step.codes)}>
                <Download className="h-4 w-4" aria-hidden />
                {t("downloadCodes")}
              </Button>
              <Button type="button" size="sm" onClick={() => go({ name: "idle" })}>
                {t("savedCodes")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
