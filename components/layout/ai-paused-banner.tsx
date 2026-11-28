"use client";

import { useTranslations } from "next-intl";
import { PauseCircle } from "lucide-react";
import { useFeatureFlags } from "@/lib/api/hooks/features";

/**
 * Step 10.6: while an admin has paused AI calls (the `ai` kill switch), the app
 * says so once at the top, so a disabled Send button isn't a mystery. Reading,
 * comments and the rest of the app keep working.
 */
export function AiPausedBanner() {
  const t = useTranslations("FeaturePause");
  const features = useFeatureFlags();
  if (features.ai) return null;
  return (
    <div
      role="status"
      data-testid="ai-paused-banner"
      className="flex items-center gap-2 border-b border-border bg-warning/15 px-4 py-2.5 text-xs text-fg sm:text-sm"
    >
      <PauseCircle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0">
        <strong className="font-semibold">{t("aiTitle")}</strong> {t("aiText")}
      </span>
    </div>
  );
}
