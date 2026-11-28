"use client";

import * as React from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsSection } from "@/components/settings/settings-section";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks/query-keys";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/error-message";

interface DataExport {
  id: string;
  status: "PENDING" | "READY" | "FAILED" | "EXPIRED";
  createdAt: string;
  expiresAt: string | null;
  bytes: number | null;
  filesIncluded: number;
  filesSkipped: number;
}

interface ExportsOverview {
  exports: DataExport[];
  nextAllowedAt: string | null;
}

interface DeletionBlocker {
  type: "workspace" | "project";
  id: string;
  name: string;
  memberCount: number;
  pendingTransfer: { toUserName: string; expiresAt: string } | null;
}

interface DeletionOverview {
  email: string;
  hasPassword: boolean;
  graceDays: number;
  blockers: DeletionBlocker[];
  subscription: { plan: string; periodEnd: string | null } | null;
}

/** Step 9.5: Settings → Your data (download a copy, delete the account). */
export function YourDataSettings({ userId }: { userId: string }) {
  return (
    <>
      <ExportSection userId={userId} />
      <RecentlyDeletedLink />
      <DeleteSection userId={userId} />
    </>
  );
}

/** Pre-10.6 fix: deleted workspaces and projects can be restored for 30 days. */
function RecentlyDeletedLink() {
  const t = useTranslations("Settings.data");
  return (
    <SettingsSection title={t("recentlyDeletedTitle")} description={t("recentlyDeletedHint")}>
      <div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/deleted">{t("recentlyDeletedOpen")}</Link>
        </Button>
      </div>
    </SettingsSection>
  );
}

function ExportSection({ userId }: { userId: string }) {
  const t = useTranslations("Settings.data");
  const tRoot = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [requesting, setRequesting] = React.useState(false);
  const query = useQuery({
    queryKey: queryKeys.me.exports(userId),
    queryFn: ({ signal }) => api<ExportsOverview>("/api/v1/me/exports", { signal }),
    // Check again while an export is being prepared.
    refetchInterval: (q) => (q.state.data?.exports.some((e) => e.status === "PENDING") ? 5000 : false),
  });
  const data = query.data;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  const request = async () => {
    setRequesting(true);
    try {
      await api("/api/v1/me/exports", { method: "POST" });
      toast.success(t("exportRequested"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.me.exports(userId) });
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("exportError")));
    } finally {
      setRequesting(false);
    }
  };

  const waitUntil = data?.nextAllowedAt && new Date(data.nextAllowedAt) > new Date() ? data.nextAllowedAt : null;

  return (
    <SettingsSection title={t("exportTitle")} description={t("exportHint")} data-testid="settings-data-export">
      {query.isError ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>{t("loadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        </div>
      ) : !data ? (
        <Skeleton className="h-16 w-full rounded-xl" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void request()} disabled={requesting || Boolean(waitUntil)}>
              {requesting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t("exportButton")}
            </Button>
            {waitUntil && <span className="text-xs text-muted">{t("exportWait", { date: date(waitUntil) })}</span>}
          </div>
          {data.exports.length > 0 && (
            <ul className="divide-y divide-border rounded-xl border border-border" aria-label={t("exportListLabel")}>
              {data.exports.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="text-fg">{t("exportRequestedAt", { date: date(e.createdAt) })}</p>
                    <p className="text-xs text-muted" role={e.status === "PENDING" ? "status" : undefined}>
                      {e.status === "PENDING" && t("statusPending")}
                      {e.status === "READY" && e.expiresAt && t("statusReady", { date: date(e.expiresAt) })}
                      {e.status === "EXPIRED" && t("statusExpired")}
                      {e.status === "FAILED" && t("statusFailed")}
                      {e.status === "READY" && e.filesSkipped > 0 && ` ${t("filesSkipped", { count: e.filesSkipped })}`}
                    </p>
                  </div>
                  {e.status === "PENDING" && <Loader2 className="h-4 w-4 animate-spin text-muted" aria-hidden />}
                  {e.status === "READY" && (
                    <Button asChild size="sm" variant="outline">
                      <a href={`/api/v1/me/exports/${e.id}/download`} download>
                        <Download className="h-3.5 w-3.5" aria-hidden />
                        {t("download")}
                      </a>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function DeleteSection({ userId }: { userId: string }) {
  const t = useTranslations("Settings.data");
  const tRoot = useTranslations();
  const format = useFormatter();
  const query = useQuery({
    queryKey: queryKeys.me.accountDeletion(userId),
    queryFn: ({ signal }) => api<DeletionOverview>("/api/v1/me/account/deletion", { signal }),
  });
  const data = query.data;
  const [open, setOpen] = React.useState(false);
  const [confirmEmail, setConfirmEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [needsPassword, setNeedsPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "long" });

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setConfirmEmail("");
      setPassword("");
      setNeedsPassword(false);
      setError(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/me/account/deletion", {
        method: "POST",
        body: { confirmEmail, ...(password ? { password } : {}) },
      });
      // A full page load, so nothing of the signed-in app stays in memory.
      window.location.replace("/auth/login?reason=account_deleted");
    } catch (err) {
      const code = getApiErrorCode(err);
      if (code === "FRESH_LOGIN_REQUIRED") {
        if (data?.hasPassword) {
          setNeedsPassword(true);
          setError(password ? t("wrongPassword") : t("passwordNeeded"));
        } else {
          setError(t("signInAgain"));
        }
      } else if (code === "INVALID_PASSWORD") {
        setError(t("wrongPassword"));
      } else if (code === "deletion_blocked") {
        setError(t("stillBlocked"));
        void query.refetch();
      } else {
        setError(getApiErrorMessage(err, tRoot, t("deleteError")));
      }
      setBusy(false);
    }
  };

  const emailMatches = data ? confirmEmail.trim().toLowerCase() === data.email.toLowerCase() : false;

  return (
    <SettingsSection title={t("deleteTitle")} description={t("deleteHint", { days: data?.graceDays ?? 30 })} data-testid="settings-data-delete">
      {query.isError ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>{t("loadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        </div>
      ) : !data ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <>
          <ul className="list-disc space-y-1 ps-5 text-sm text-muted">
            <li>{t("whatHappens.signOut")}</li>
            <li>{t("whatHappens.restore", { days: data.graceDays })}</li>
            <li>{t("whatHappens.erase")}</li>
            <li>{t("whatHappens.kept")}</li>
            {data.subscription && (
              <li>
                {data.subscription.periodEnd
                  ? t("whatHappens.subscription", { date: day(data.subscription.periodEnd) })
                  : t("whatHappens.subscriptionNoDate")}
              </li>
            )}
            <li>{t("whatHappens.exportFirst")}</li>
          </ul>

          {data.blockers.length > 0 && (
            <div className="rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="deletion-blockers">
              <p className="flex items-center gap-2 font-medium text-fg">
                <TriangleAlert className="h-4 w-4 text-warning" aria-hidden />
                {t("blockersTitle")}
              </p>
              <p className="mt-1 text-xs text-muted">{t("blockersHint")}</p>
              <ul className="mt-2 space-y-1.5">
                {data.blockers.map((b) => (
                  <li key={`${b.type}:${b.id}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <Link
                      href={b.type === "workspace" ? `/workspaces/${b.id}` : `/projects/${b.id}`}
                      className="font-medium text-accent underline-offset-2 hover:underline"
                    >
                      {b.name}
                    </Link>
                    <span className="text-xs text-muted">
                      {b.pendingTransfer
                        ? t("blockerTransfer", { name: b.pendingTransfer.toUserName, date: day(b.pendingTransfer.expiresAt) })
                        : t(b.type === "workspace" ? "blockerWorkspace" : "blockerProject", { count: b.memberCount })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <Button type="button" variant="destructive" onClick={() => setOpen(true)} disabled={data.blockers.length > 0}>
              {t("deleteButton")}
            </Button>
          </div>

          <Dialog open={open} onOpenChange={close}>
            <DialogContent>
              <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
                <DialogHeader>
                  <DialogTitle>{t("confirmTitle")}</DialogTitle>
                  <DialogDescription>{t("confirmBody", { days: data.graceDays })}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="delete-confirm-email">{t("confirmEmailLabel", { email: data.email })}</Label>
                  <Input
                    id="delete-confirm-email"
                    type="email"
                    autoComplete="off"
                    value={confirmEmail}
                    onChange={(e) => setConfirmEmail(e.target.value)}
                  />
                </div>
                {needsPassword && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="delete-password">{t("passwordLabel")}</Label>
                    <Input
                      id="delete-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                )}
                {error && (
                  <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
                    {error}
                  </p>
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
                    {t("cancel")}
                  </Button>
                  <Button type="submit" variant="destructive" disabled={busy || !emailMatches || (needsPassword && !password)}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    {t("confirmButton")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </>
      )}
    </SettingsSection>
  );
}
