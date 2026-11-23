"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, ArrowLeft, KeyRound, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { getAuthErrorMessage } from "@/lib/api/error-message";
import {
  TOTP_CODE_LENGTH,
  TWO_FACTOR_TRUST_DAYS,
  normalizeBackupCode,
  normalizeTotpCode,
  safeNextPath,
} from "@/lib/auth/two-factor";
import { DEFAULT_LOGIN_REDIRECT } from "@/utils/routes";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useSiteConfig } from "@/components/providers/site-config-provider";

/** Challenge codes that mean "start over from the sign-in page". */
const EXPIRED_CODES = new Set(["INVALID_TWO_FACTOR_COOKIE", "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"]);

/**
 * Two-factor sign-in, step 2: the 6-digit code from the authenticator app, or
 * one backup code. Shown after a correct password when two-factor is on.
 */
export function TwoFactorChallengeForm() {
  const t = useTranslations("Auth.twoFactor");
  const tRoot = useTranslations();
  const router = useRouter();
  const site = useSiteConfig();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams?.get("next"), DEFAULT_LOGIN_REDIRECT);

  const [mode, setMode] = React.useState<"totp" | "backup">("totp");
  const [code, setCode] = React.useState("");
  const [trustDevice, setTrustDevice] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const switchMode = () => {
    setMode((m) => (m === "totp" ? "backup" : "totp"));
    setCode("");
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const ready = mode === "totp" ? code.length === TOTP_CODE_LENGTH : code.length >= 6;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { error: authError } =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
          : await authClient.twoFactor.verifyBackupCode({ code, trustDevice });
      if (authError) {
        if (authError.code && EXPIRED_CODES.has(authError.code)) setExpired(true);
        setError(getAuthErrorMessage(authError, tRoot, t("errorGeneric")));
        setCode("");
        inputRef.current?.focus();
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-3xl border border-border bg-surface/90 backdrop-blur-xl p-6 sm:p-8 shadow-lg text-fg space-y-6">
      <div className="text-center space-y-2">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
          {mode === "totp" ? <ShieldCheck className="h-6 w-6" aria-hidden /> : <KeyRound className="h-6 w-6" aria-hidden />}
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">{t("title")}</h1>
        <p className="text-xs sm:text-sm text-fg-muted leading-relaxed">
          {mode === "totp" ? t("subtitleTotp") : t("subtitleBackup")}
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-xs text-danger flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {expired ? (
        <Button asChild className="w-full h-11 rounded-xl text-xs font-semibold">
          <Link href="/auth/login">{t("signInAgain")}</Link>
        </Button>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="two-factor-code" className="text-xs font-semibold text-fg">
              {mode === "totp" ? t("codeLabel") : t("backupLabel")}
            </label>
            <Input
              id="two-factor-code"
              ref={inputRef}
              autoFocus
              value={code}
              onChange={(e) =>
                setCode(mode === "totp" ? normalizeTotpCode(e.target.value) : normalizeBackupCode(e.target.value))
              }
              inputMode={mode === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={mode === "totp" ? TOTP_CODE_LENGTH : 64}
              placeholder={mode === "totp" ? t("codePlaceholder") : t("backupPlaceholder")}
              className="h-12 text-center font-mono text-lg tracking-[0.3em] bg-surface-2/40"
            />
          </div>

          <label className="flex items-start gap-2.5 text-xs text-fg-muted cursor-pointer">
            <Checkbox
              checked={trustDevice}
              onCheckedChange={(v) => setTrustDevice(v === true)}
              className="mt-0.5"
            />
            <span>{t("trustDevice", { days: TWO_FACTOR_TRUST_DAYS })}</span>
          </label>

          <Button type="submit" disabled={!ready || loading} className="w-full h-11 rounded-xl text-xs font-semibold">
            {loading ? t("verifying") : t("verify")}
          </Button>
        </form>
      )}

      <div className="flex flex-col items-center gap-3 text-xs">
        {!expired && (
          <button type="button" onClick={switchMode} className="font-semibold text-accent hover:underline">
            {mode === "totp" ? t("useBackup") : t("useApp")}
          </button>
        )}
        <p className="text-center text-fg-subtle leading-relaxed">{t("lostAccess", { email: site.emails.support })}</p>
        <Link href="/auth/login" className="inline-flex items-center gap-1.5 text-fg-muted hover:text-accent">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t("backToSignIn")}
        </Link>
      </div>
    </div>
  );
}
