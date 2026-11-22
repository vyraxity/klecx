"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Gauge, Loader2, Pause, Play, SkipBack, SkipForward, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { speechTargetKey, useReadAloud } from "@/lib/speech/player-store";
import type { SpeechTarget } from "@/lib/schemas/speech";
import { cn } from "@/lib/utils";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * Step 9.4: "Read aloud" on any readable text. While this text is being read
 * it turns into a small player: pause/resume, previous/next part, stop and
 * speed. Only one text is read at a time.
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
  const active = useReadAloud((s) => s.targetKey === key);
  const status = useReadAloud((s) => s.status);
  const index = useReadAloud((s) => s.index);
  const total = useReadAloud((s) => s.total);
  const speed = useReadAloud((s) => s.speed);
  const fallback = useReadAloud((s) => s.fallback);
  const error = useReadAloud((s) => s.error);
  const truncated = useReadAloud((s) => s.truncated);
  const { start, pause, resume, stop, skip, setSpeed } = useReadAloud.getState();
  const showPlayer = active && status !== "idle";

  // Focus follows the swap between the button and the player (keyboard users):
  // pressing Read aloud moves focus to Pause; when reading stops or ends,
  // focus comes back to Read aloud — but only if focus was ours to move.
  const readButtonRef = React.useRef<HTMLButtonElement>(null);
  const playPauseRef = React.useRef<HTMLButtonElement>(null);
  const groupRef = React.useRef<HTMLDivElement>(null);
  const moveFocusToPlayer = React.useRef(false);
  const playerHadFocus = React.useRef(false);
  const wasShown = React.useRef(showPlayer);
  React.useLayoutEffect(() => {
    if (showPlayer && !wasShown.current && moveFocusToPlayer.current) {
      playPauseRef.current?.focus();
      moveFocusToPlayer.current = false;
    }
    if (!showPlayer && wasShown.current && playerHadFocus.current) {
      const focusLost = !document.activeElement || document.activeElement === document.body;
      if (focusLost) readButtonRef.current?.focus();
      playerHadFocus.current = false;
    }
    wasShown.current = showPlayer;
  }, [showPlayer]);

  // Say once why the voice changed or why reading stopped.
  const lastNotice = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!active) return;
    const notice = fallback ? `f:${fallback}` : error ? `e:${error}` : truncated ? "truncated" : null;
    if (!notice || notice === lastNotice.current) return;
    lastNotice.current = notice;
    if (fallback === "daily_limit") toast.info(t("fallbackDailyLimit"));
    else if (fallback === "plan") toast.info(t("fallbackPlan"));
    else if (fallback === "unavailable") toast.info(t("fallbackUnavailable"));
    else if (error) toast.error(error === "unsupported" ? t("unsupported") : t("error"));
    else if (truncated) toast.info(t("truncated"));
  }, [active, fallback, error, truncated, t]);

  if (!showPlayer) {
    return (
      <Button
        ref={readButtonRef}
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          moveFocusToPlayer.current = true;
          void start(target);
        }}
        aria-label={t("readAloud")}
        title={compact ? t("readAloud") : undefined}
        className={cn("text-muted hover:text-fg h-8 px-2 text-xs", className)}
        data-testid="read-aloud"
      >
        <Volume2 className={cn("h-3.5 w-3.5", !compact && "mr-1")} aria-hidden />
        {!compact && <span>{t("readAloud")}</span>}
      </Button>
    );
  }

  const playing = status === "playing";
  return (
    <div
      ref={groupRef}
      role="group"
      onFocus={() => {
        playerHadFocus.current = true;
      }}
      onBlur={(e) => {
        // Still ours while focus moves within the player or into its speed menu.
        const next = e.relatedTarget as Node | null;
        if (next && !groupRef.current?.contains(next) && !(next as HTMLElement).closest?.("[data-radix-popper-content-wrapper]")) {
          playerHadFocus.current = false;
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          stop();
        }
      }}
      aria-label={t("player")}
      className={cn("inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 px-1", className)}
      data-testid="read-aloud-player"
      data-annot-ignore="true"
    >
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => skip(-1)} disabled={index === 0} aria-label={t("previous")} title={t("previous")}>
        <SkipBack className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button
        ref={playPauseRef}
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => (playing ? pause() : status === "paused" ? resume() : undefined)}
        aria-label={playing ? t("pause") : t("resume")}
        title={playing ? t("pause") : t("resume")}
      >
        {status === "loading" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : playing ? (
          <Pause className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Play className="h-3.5 w-3.5" aria-hidden />
        )}
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => skip(1)} disabled={index >= total - 1} aria-label={t("next")} title={t("next")}>
        <SkipForward className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <span className="px-1 text-[11px] text-muted tabular-nums" aria-live="polite">
        {t("part", { index: Math.min(index + 1, Math.max(total, 1)), total: Math.max(total, 1) })}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-8 px-1.5 text-[11px]" aria-label={t("speed")} title={t("speed")}>
            <Gauge className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t("speedValue", { speed })}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={String(speed)} onValueChange={(v) => setSpeed(Number(v))}>
            {SPEEDS.map((s) => (
              <DropdownMenuRadioItem key={s} value={String(s)}>
                {t("speedValue", { speed: s })}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={stop} aria-label={t("stop")} title={t("stop")}>
        <Square className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Link href="/settings/voice" className="sr-only focus:not-sr-only focus:px-1 focus:text-[11px]">
        {t("voiceSettings")}
      </Link>
    </div>
  );
}
