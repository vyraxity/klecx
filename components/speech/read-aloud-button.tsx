"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AudioLines, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { speechTargetKey, useReadAloud } from "@/lib/speech/player-store";
import { setReadAloudOrigin } from "@/lib/speech/player-origin";
import type { SpeechTarget } from "@/lib/schemas/speech";
import { cn } from "@/lib/utils";

/**
 * Step 9.4: "Read aloud" on any readable text. The controls live in the
 * floating player (`ReadAloudDock`, in the app shell), so they stay on screen
 * wherever the page is scrolled. While this text is being read, this button
 * shows it and stops the reading when pressed again.
 */
export function ReadAloudButton({
  target,
  className,
  compact = false,
}: {
  target: SpeechTarget;
  className?: string;
  /** Icon only (narrow toolbars). */
  compact?: boolean;
}) {
  const t = useTranslations("Speech");
  const key = speechTargetKey(target);
  const reading = useReadAloud((s) => s.targetKey === key && s.status !== "idle");
  const label = reading ? t("stop") : t("readAloud");

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={(e) => {
        const { start, stop } = useReadAloud.getState();
        if (reading) return stop();
        setReadAloudOrigin(e.currentTarget, true);
        void start(target);
      }}
      aria-label={label}
      aria-pressed={reading}
      title={compact ? label : undefined}
      className={cn("h-8 px-2 text-xs", reading ? "text-accent" : "text-muted hover:text-fg", className)}
      data-testid="read-aloud"
    >
      {reading ? (
        <AudioLines className={cn("h-3.5 w-3.5 motion-safe:animate-pulse", !compact && "mr-1")} aria-hidden />
      ) : (
        <Volume2 className={cn("h-3.5 w-3.5", !compact && "mr-1")} aria-hidden />
      )}
      {!compact && <span>{reading ? t("reading") : t("readAloud")}</span>}
    </Button>
  );
}
