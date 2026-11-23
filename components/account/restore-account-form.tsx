"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { getApiErrorCode } from "@/lib/api/error-message";

/**
 * Step 9.5: restores a deleted account with the token from the email. A
 * button (not an automatic call) so that link scanners opening the URL don't
 * restore the account by themselves.
 */
export function RestoreAccountForm() {
  const t = useTranslations("AccountRestore");
  const token = useSearchParams()?.get("token") ?? "";
  const [state, setState] = React.useState<"idle" | "busy" | "done" | "invalid" | "error">(token ? "idle" : "invalid");

  const restore = async () => {
    setState("busy");
    try {
      await api("/api/v1/account/restore", { method: "POST", body: { token } });
      setState("done");
    } catch (err) {
      setState(getApiErrorCode(err) === "restore_link_invalid" || getApiErrorCode(err) === "validation_error" ? "invalid" : "error");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-6 text-center shadow-sm">
      <h1 className="text-xl font-semibold text-fg">{t("title")}</h1>
      {state === "done" ? (
        <>
          <p className="text-sm text-muted" role="status">{t("done")}</p>
          <Button asChild>
            <Link href="/auth/login">{t("signIn")}</Link>
          </Button>
        </>
      ) : state === "invalid" ? (
        <p className="text-sm text-muted" role="alert">{t("invalid")}</p>
      ) : (
        <>
          <p className="text-sm text-muted">{t("body")}</p>
          {state === "error" && (
            <p className="text-sm text-danger" role="alert">{t("error")}</p>
          )}
          <Button type="button" onClick={() => void restore()} disabled={state === "busy"}>
            {state === "busy" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t("button")}
          </Button>
        </>
      )}
    </div>
  );
}
