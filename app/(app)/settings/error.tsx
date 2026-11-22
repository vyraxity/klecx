"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/** Step 9.1: a Settings page that failed to load; the nav stays usable. */
export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("Settings.errors");

  React.useEffect(() => {
    console.error("[Settings Error]", { digest: error.digest });
  }, [error]);

  return (
    <EmptyState
      icon={<AlertCircle className="h-6 w-6 text-accent" />}
      title={t("pageTitle")}
      description={t("pageDescription")}
      action={
        <Button type="button" variant="outline" onClick={reset}>
          <RefreshCw className="h-4 w-4" />
          {t("retry")}
        </Button>
      }
    />
  );
}
