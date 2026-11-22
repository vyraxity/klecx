"use client";

import * as React from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsSection } from "@/components/settings/settings-section";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks/query-keys";
import { authClient } from "@/lib/auth-client";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/error-message";
import {
  SOCIAL_PROVIDERS,
  type SignInMethod,
  type SocialProvider,
} from "@/lib/schemas/account-security";

interface LinkedAccounts {
  methods: { provider: SignInMethod; linkedAt: string }[];
  available: SocialProvider[];
  hasPassword: boolean;
}

/**
 * Step 9.1: sign-in methods. Google/GitHub can be connected (Better Auth's
 * OAuth flow) and disconnected (`DELETE /api/v1/me/linked-accounts/:provider`),
 * never the last way to sign in. Provider names are allowed here (rule 6:
 * sign-in buttons).
 */
export function LinkedAccountsCard({ userId, linkError }: { userId: string; linkError: boolean }) {
  const t = useTranslations("Settings.security");
  const tAuth = useTranslations("Auth");
  const tRoot = useTranslations();
  const format = useFormatter();
  const query = useQuery({
    queryKey: queryKeys.me.linkedAccounts(userId),
    queryFn: ({ signal }) => api<LinkedAccounts>("/api/v1/me/linked-accounts", { signal }),
  });
  const data = query.data ?? null;
  const failed = query.isError;
  const load = query.refetch;
  const [busy, setBusy] = React.useState<SocialProvider | null>(null);
  const [confirming, setConfirming] = React.useState<SocialProvider | null>(null);
  const [needsPassword, setNeedsPassword] = React.useState(false);
  const [password, setPassword] = React.useState("");

  const connect = async (provider: SocialProvider) => {
    setBusy(provider);
    try {
      const { error } = await authClient.linkSocial({
        provider,
        callbackURL: "/settings/security",
        errorCallbackURL: "/settings/security?linkError=1",
      });
      if (error) {
        toast.error(t("connectError"));
        setBusy(null);
      }
      // On success the browser leaves for the provider's page.
    } catch {
      toast.error(t("connectError"));
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!confirming) return;
    const provider = confirming;
    setBusy(provider);
    try {
      await api(`/api/v1/me/linked-accounts/${provider}`, {
        method: "DELETE",
        body: needsPassword ? { password } : {},
      });
      toast.success(t("disconnected", { provider: providerName(provider) }));
      setConfirming(null);
      setNeedsPassword(false);
      setPassword("");
      await load();
    } catch (err) {
      if (getApiErrorCode(err) === "FRESH_LOGIN_REQUIRED" && data?.hasPassword && !needsPassword) {
        setNeedsPassword(true);
      } else {
        toast.error(getApiErrorMessage(err, tRoot, t("disconnectError")));
      }
    } finally {
      setBusy(null);
    }
  };

  const providerName = (p: SocialProvider) => tAuth(p === "google" ? "google" : "github");

  if (failed) {
    return (
      <SettingsSection title={t("methodsTitle")}>
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>{t("methodsLoadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {t("retry")}
          </Button>
        </div>
      </SettingsSection>
    );
  }

  if (!data) return <Skeleton className="h-40 w-full rounded-2xl" />;

  const linked = new Map(data.methods.map((m) => [m.provider, m]));
  const methodCount = data.methods.filter((m) => m.provider !== "credential" || data.hasPassword).length;
  const rows: SignInMethod[] = ["credential", ...SOCIAL_PROVIDERS];

  return (
    <SettingsSection title={t("methodsTitle")} description={t("methodsHint")} data-testid="settings-linked-accounts">
      {linkError && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
          {t("connectFailed")}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((method) => {
          const entry = linked.get(method);
          const isLinked = method === "credential" ? data.hasPassword : Boolean(entry);
          const label = method === "credential" ? t("methodPassword") : providerName(method);
          const available = method === "credential" || data.available.includes(method);
          if (!isLinked && !available) return null;
          return (
            <li key={method} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-xs font-bold text-fg">
                  {method === "credential" ? <KeyRound className="h-4 w-4" aria-hidden /> : label.charAt(0)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-fg">{label}</p>
                  <p className="text-xs text-muted">
                    {isLinked
                      ? entry
                        ? t("connectedOn", {
                            date: format.dateTime(new Date(entry.linkedAt), { dateStyle: "medium" }),
                          })
                        : t("connected")
                      : t("notConnected")}
                  </p>
                </div>
              </div>
              {method !== "credential" &&
                (isLinked ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || methodCount <= 1}
                    title={methodCount <= 1 ? t("lastMethod") : undefined}
                    onClick={() => setConfirming(method)}
                  >
                    {t("disconnect")}
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy !== null} onClick={() => void connect(method)}>
                    {busy === method && <Spinner size="sm" />}
                    {t("connect")}
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
      {methodCount <= 1 && !data.hasPassword && <p className="text-xs text-muted">{t("lastMethod")}</p>}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
            setNeedsPassword(false);
            setPassword("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("disconnectTitle", { provider: confirming ? providerName(confirming) : "" })}
            </DialogTitle>
            <DialogDescription>{t("disconnectBody")}</DialogDescription>
          </DialogHeader>
          {needsPassword && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-unlink-password">{t("currentPassword")}</Label>
              <Input
                id="settings-unlink-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted">{t("reauthHint")}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy !== null}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void disconnect()}
              disabled={busy !== null || (needsPassword && !password)}
            >
              {busy !== null && <Spinner size="sm" />}
              {t("disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
