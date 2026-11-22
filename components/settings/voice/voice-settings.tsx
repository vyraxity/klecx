"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { useSiteConfig } from "@/components/providers/site-config-provider";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks/query-keys";
import { useUpdateUserPreferences } from "@/lib/api/hooks/me";
import { getApiErrorMessage } from "@/lib/api/error-message";
import { PLAN_MANAGE_HREF } from "@/lib/billing/links";
import { MAX_VOICE_SPEED, MIN_VOICE_SPEED, VOICE_PROVIDERS, type VoiceProvider } from "@/lib/speech/voices";
import { cn } from "@/lib/utils";

interface VoiceOverview {
  provider: VoiceProvider;
  voiceId: string | null;
  speed: number;
  naturalAllowed: boolean;
  voices: { id: string; number: number; style: string }[];
  dailyLimitSeconds: number;
  usedTodaySeconds: number;
}

const BROWSER_DEFAULT = "";
const noopSubscribe = () => () => {};

/** Browser voices, once the browser has loaded them (they arrive late in some browsers). */
function useBrowserVoices(): SpeechSynthesisVoice[] {
  const supported = React.useSyncExternalStore(
    noopSubscribe,
    () => "speechSynthesis" in window,
    () => false
  );
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([]);
  React.useEffect(() => {
    if (!supported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [supported]);
  return voices;
}

/** Step 9.4: Settings → Voice. */
export function VoiceSettings({ userId }: { userId: string }) {
  const t = useTranslations("Settings.voice");
  const tSpeech = useTranslations("Speech");
  const tRoot = useTranslations();
  const { billingEnabled } = useSiteConfig();
  const queryClient = useQueryClient();
  const update = useUpdateUserPreferences(userId);
  const browserVoices = useBrowserVoices();
  const [previewing, setPreviewing] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const query = useQuery({
    queryKey: queryKeys.me.voices(userId),
    queryFn: ({ signal }) => api<VoiceOverview>("/api/v1/speech/voices", { signal }),
  });
  const data = query.data;
  const [speed, setSpeedState] = React.useState<number | null>(null);
  const shownSpeed = speed ?? data?.speed ?? 1;

  const save = (input: Parameters<typeof update.mutate>[0]) => {
    update.mutate(input, {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.me.voices(userId) }),
      onError: (err) => toast.error(getApiErrorMessage(err, tRoot, t("saveError"))),
    });
  };

  const previewNatural = async (voiceId: string) => {
    setPreviewing(voiceId);
    try {
      const { url } = await api<{ url: string }>("/api/v1/speech/preview", { method: "POST", body: { voiceId } });
      audioRef.current?.pause();
      audioRef.current = new Audio(url);
      audioRef.current.playbackRate = shownSpeed;
      await audioRef.current.play();
    } catch (err) {
      toast.error(getApiErrorMessage(err, tRoot, t("previewError")));
    } finally {
      setPreviewing(null);
    }
  };

  const previewBrowser = (name: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(tSpeech("previewSample"));
    u.rate = shownSpeed;
    u.lang = document.documentElement.lang || "en";
    const v = browserVoices.find((x) => x.name === name);
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  };

  if (query.isError) {
    return (
      <SettingsSection title={t("title")}>
        <div className="flex items-center justify-between gap-3 text-xs text-muted">
          <span>{t("loadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        </div>
      </SettingsSection>
    );
  }
  if (!data) return <Skeleton className="h-64 w-full rounded-2xl" />;

  const minutes = (s: number) => Math.round(s / 60);

  return (
    <>
      <SettingsSection title={t("providerTitle")} description={t("providerHint")} data-testid="settings-voice-provider">
        <RadioGroup
          value={data.provider}
          onValueChange={(v) => save({ voiceProvider: v as VoiceProvider, voiceId: null })}
          aria-label={t("providerTitle")}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {VOICE_PROVIDERS.map((p) => {
            const disabled = p === "natural" && !data.naturalAllowed;
            return (
              <label
                key={p}
                htmlFor={`voice-provider-${p}`}
                className={cn(
                  "flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm",
                  disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  data.provider === p ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2"
                )}
              >
                <RadioGroupItem id={`voice-provider-${p}`} value={p} disabled={disabled} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block font-medium text-fg">{t(`providers.${p}`)}</span>
                  <span className="block text-xs text-muted">{t(`providers.${p}Hint`)}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
        {!data.naturalAllowed && (
          <p className="text-xs text-muted">
            {t("naturalPlan")}{" "}
            {billingEnabled && (
              <Link href={PLAN_MANAGE_HREF} className="font-medium text-accent underline-offset-2 hover:underline">
                {t("seePlans")}
              </Link>
            )}
          </p>
        )}
        {data.naturalAllowed && (
          <p className="text-xs text-muted">
            {t("usedToday", { used: minutes(data.usedTodaySeconds), limit: minutes(data.dailyLimitSeconds) })}
          </p>
        )}
      </SettingsSection>

      <SettingsSection title={t("voiceTitle")} description={t("voiceHint")} data-testid="settings-voice-choice">
        {data.provider === "natural" ? (
          <RadioGroup
            value={data.voiceId ?? ""}
            onValueChange={(v) => save({ voiceProvider: "natural", voiceId: v })}
            aria-label={t("voiceTitle")}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {data.voices.map((v) => (
              <div
                key={v.id}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
                  data.voiceId === v.id ? "border-accent bg-accent/5" : "border-border"
                )}
              >
                <RadioGroupItem id={`voice-${v.id}`} value={v.id} />
                <label htmlFor={`voice-${v.id}`} className="min-w-0 flex-1 cursor-pointer text-fg">
                  {t("voiceName", { number: v.number })}
                  <span className="text-muted"> · {t(`styles.${v.style}`)}</span>
                </label>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => void previewNatural(v.id)}
                  disabled={previewing !== null}
                  aria-label={t("preview", { name: t("voiceName", { number: v.number }) })}
                  title={t("preview", { name: t("voiceName", { number: v.number }) })}
                >
                  {previewing === v.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                </Button>
              </div>
            ))}
          </RadioGroup>
        ) : browserVoices.length === 0 ? (
          <p className="text-xs text-muted">{t("noBrowserVoices")}</p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label htmlFor="browser-voice" className="sr-only">
              {t("voiceTitle")}
            </label>
            <select
              id="browser-voice"
              value={data.voiceId ?? BROWSER_DEFAULT}
              onChange={(e) => save({ voiceProvider: "browser", voiceId: e.target.value || null })}
              className="w-full max-w-sm cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value={BROWSER_DEFAULT}>{t("browserDefault")}</option>
              {browserVoices.map((v) => (
                <option key={v.voiceURI} value={v.name}>
                  {t("browserVoiceOption", { name: v.name, lang: v.lang })}
                </option>
              ))}
            </select>
            <Button type="button" size="sm" variant="outline" onClick={() => previewBrowser(data.voiceId ?? BROWSER_DEFAULT)}>
              <Play className="h-3.5 w-3.5" aria-hidden />
              {t("previewShort")}
            </Button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("speedTitle")} description={t("speedHint")} data-testid="settings-voice-speed">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={MIN_VOICE_SPEED}
            max={MAX_VOICE_SPEED}
            step={0.25}
            value={shownSpeed}
            aria-label={t("speedTitle")}
            onChange={(e) => setSpeedState(Number(e.target.value))}
            onPointerUp={() => speed !== null && save({ voiceSpeed: speed })}
            onKeyUp={() => speed !== null && save({ voiceSpeed: speed })}
            className="w-full max-w-xs accent-accent"
          />
          <span className="w-12 text-sm font-semibold text-fg tabular-nums">{tSpeech("speedValue", { speed: shownSpeed })}</span>
        </div>
      </SettingsSection>
    </>
  );
}
