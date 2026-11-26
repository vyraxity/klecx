"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Gauge, Loader2, LocateFixed, Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useReadAloud } from "@/lib/speech/player-store";
import { getReadAloudOrigin, takeFocusRequest } from "@/lib/speech/player-origin";
import { cn } from "@/lib/utils";
import { scrollBehavior } from "@/lib/a11y/motion";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
/** 32 px on larger screens, 44 px touch targets on phones. */
const ICON_BUTTON = "h-8 w-8 min-h-8 rounded-full max-sm:h-11 max-sm:w-11 max-sm:min-h-11";

/**
 * Step 9.4: the floating read-aloud player (owner, 2026-11-23). Mounted once
 * in the app shell, at the top centre of the content area, so its controls
 * stay visible wherever the page is scrolled (and after leaving the page).
 * Pause/resume, previous/next part, speed, stop, and a button back to the
 * text being read.
 *
 * Focus (keyboard users): pressing Read aloud moves focus to Pause; when
 * reading stops or ends while focus is in the player, it goes back to the
 * Read aloud button that started it. Escape in the player stops reading.
 *
 * Screen readers (Step 10.5): the player is a labelled group; a polite status
 * region (kept mounted while idle, so "stopped" is heard) says when reading
 * starts, pauses, resumes and stops, once per change and never per part, so it
 * doesn't talk over the reading. The part counter reads "Part 2 of 5". Phones
 * get 44 px targets.
 */
export function ReadAloudDock({ className }: { className?: string }) {
  const t = useTranslations("Speech");
  const status = useReadAloud((s) => s.status);
  const index = useReadAloud((s) => s.index);
  const total = useReadAloud((s) => s.total);
  const speed = useReadAloud((s) => s.speed);
  const fallback = useReadAloud((s) => s.fallback);
  const error = useReadAloud((s) => s.error);
  const truncated = useReadAloud((s) => s.truncated);
  const targetKey = useReadAloud((s) => s.targetKey);
  const { pause, resume, stop, skip, setSpeed } = useReadAloud.getState();
  const shown = status !== "idle";

  const groupRef = React.useRef<HTMLDivElement>(null);
  const playPauseRef = React.useRef<HTMLButtonElement>(null);
  const hadFocus = React.useRef(false);
  const wasShown = React.useRef(shown);
  React.useLayoutEffect(() => {
    if (shown && !wasShown.current && takeFocusRequest()) playPauseRef.current?.focus();
    if (!shown && wasShown.current && hadFocus.current) {
      const focusLost = !document.activeElement || document.activeElement === document.body;
      if (focusLost) getReadAloudOrigin()?.focus();
      hadFocus.current = false;
    }
    wasShown.current = shown;
  }, [shown]);

  // Say once per reading why the voice changed or why reading stopped.
  const lastNotice = React.useRef<string | null>(null);
  React.useEffect(() => {
    const notice = fallback ? `f:${fallback}` : error ? `e:${error}` : truncated ? "truncated" : null;
    const id = `${targetKey ?? ""}|${notice ?? ""}`;
    if (!notice || id === lastNotice.current) return;
    lastNotice.current = id;
    if (fallback === "daily_limit") toast.info(t("fallbackDailyLimit"));
    else if (fallback === "plan") toast.info(t("fallbackPlan"));
    else if (fallback === "unavailable") toast.info(t("fallbackUnavailable"));
    else if (error) toast.error(error === "unsupported" ? t("unsupported") : t("error"));
    else if (truncated) toast.info(t("truncated"));
  }, [targetKey, fallback, error, truncated, t]);

  // What the status region says: only on a change of state (set while
  // rendering, React's pattern for state derived from a change).
  const [announcement, setAnnouncement] = React.useState("");
  const [prevStatus, setPrevStatus] = React.useState(status);
  if (prevStatus !== status) {
    setPrevStatus(status);
    // Parts load one after another (loading → playing): only the start,
    // pause, resume and stop are announced.
    if (prevStatus === "idle") setAnnouncement(t("statusReading"));
    else if (status === "idle") setAnnouncement(t("statusStopped"));
    else if (status === "paused") setAnnouncement(t("statusPaused"));
    else if (prevStatus === "paused") setAnnouncement(t("statusResumed"));
  }

  const statusRegion = (
    <span role="status" aria-live="polite" className="sr-only" data-testid="read-aloud-status">
      {announcement}
    </span>
  );

  if (!shown) return statusRegion;

  const playing = status === "playing";
  const partTotal = Math.max(total, 1);
  const partNumber = Math.min(index + 1, partTotal);
  const showText = () => {
    const el = getReadAloudOrigin();
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  };

  return (
    <>
    {statusRegion}
    <div className={cn("pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4", className)}>
      <div
        ref={groupRef}
        role="group"
        aria-label={t("player")}
        onFocus={() => {
          hadFocus.current = true;
        }}
        onBlur={(e) => {
          // Still ours while focus moves within the player or into its speed menu.
          const next = e.relatedTarget as Node | null;
          if (next && !groupRef.current?.contains(next) && !(next as HTMLElement).closest?.("[data-radix-popper-content-wrapper]")) {
            hadFocus.current = false;
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            stop();
          }
        }}
        className="pointer-events-auto inline-flex max-w-full items-center gap-0.5 rounded-full border border-border bg-surface/95 px-1.5 py-0.5 shadow-lg backdrop-blur-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
        data-testid="read-aloud-player"
        data-annot-ignore="true"
      >
        <Button type="button" variant="ghost" size="icon" className={ICON_BUTTON} onClick={showText} aria-label={t("showText")} title={t("showText")}>
          <LocateFixed className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon" className={ICON_BUTTON} onClick={() => skip(-1)} disabled={index === 0} aria-label={t("previous")} title={t("previous")}>
          <SkipBack className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          ref={playPauseRef}
          type="button"
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
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
        <Button type="button" variant="ghost" size="icon" className={ICON_BUTTON} onClick={() => skip(1)} disabled={index >= total - 1} aria-label={t("next")} title={t("next")}>
          <SkipForward className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <span className="px-1 text-[11px] text-muted tabular-nums">
          <span aria-hidden>{t("part", { index: partNumber, total: partTotal })}</span>
          <span className="sr-only">{t("partLabel", { index: partNumber, total: partTotal })}</span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-8 min-h-8 rounded-full px-1.5 text-[11px] max-sm:h-11 max-sm:min-h-11" aria-label={t("speedLabel", { speed })} title={t("speed")}>
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
        <Button type="button" variant="ghost" size="icon" className={ICON_BUTTON} onClick={stop} aria-label={t("stop")} title={t("stop")}>
          <Square className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Link href="/settings/voice" className="sr-only focus:not-sr-only focus:px-1 focus:text-[11px]">
          {t("voiceSettings")}
        </Link>
      </div>
    </div>
    </>
  );
}
