"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";
import { collectClientDiagnostics, type AppVersionInfo } from "@/lib/support/diagnostics";

/**
 * Step 9.1: the app version and a button that copies non-sensitive
 * diagnostics (browser, screen, language, version) to paste into a message.
 */
export function DiagnosticsCard({ app }: { app: AppVersionInfo }) {
  const t = useTranslations("Settings.support");

  const copy = async () => {
    const text = JSON.stringify(collectClientDiagnostics(true, app), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("diagnosticsCopied"));
    } catch {
      toast.error(t("diagnosticsCopyError"));
    }
  };

  return (
    <SettingsSection title={t("aboutTitle")} description={t("diagnosticsHint")} data-testid="settings-diagnostics">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">{t("version")}</dt>
        <dd className="font-mono text-fg">{app.version}</dd>
        {app.build && (
          <>
            <dt className="text-muted">{t("build")}</dt>
            <dd className="font-mono text-fg">{app.build}</dd>
          </>
        )}
      </dl>
      <div>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          <Copy className="h-4 w-4" aria-hidden />
          {t("copyDiagnostics")}
        </Button>
      </div>
    </SettingsSection>
  );
}
