"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/settings-section";
import { useUpdateUserPreferences, useUserPreferences } from "@/lib/api/hooks/me";
import { useUiStore } from "@/lib/stores/ui";

/**
 * Step 9.2: enter-to-send and reduced motion. Saved on the account, so every
 * device uses them; both autosave (toggles), with a toast when saving fails.
 */
export function BehaviorCard({
  userId,
  initialEnterToSend,
  initialReduceMotion,
}: {
  userId: string;
  initialEnterToSend: boolean;
  initialReduceMotion: boolean;
}) {
  const t = useTranslations("Settings.appearance");
  const { data } = useUserPreferences(userId);
  const update = useUpdateUserPreferences(userId);
  const enterToSend = data?.enterToSend ?? initialEnterToSend;
  const reduceMotion = data ? data.reduceMotion === true : initialReduceMotion;

  const setEnterToSend = (value: boolean) => {
    useUiStore.setState({ composerEnterToSend: value });
    update.mutate(
      { enterToSend: value },
      {
        onError: () => {
          useUiStore.setState({ composerEnterToSend: !value });
          toast.error(t("saveError"));
        },
      }
    );
  };

  const applyReduceMotion = (value: boolean) => {
    if (value) document.documentElement.setAttribute("data-reduce-motion", "true");
    else document.documentElement.removeAttribute("data-reduce-motion");
  };

  const setReduceMotion = (value: boolean) => {
    applyReduceMotion(value);
    update.mutate(
      { reduceMotion: value ? true : null },
      {
        onError: () => {
          applyReduceMotion(!value);
          toast.error(t("saveError"));
        },
      }
    );
  };

  return (
    <SettingsSection title={t("behaviorTitle")} description={t("behaviorHint")} data-testid="settings-behavior">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg" id="settings-enter-to-send-label">
            {t("enterToSend")}
          </p>
          <p className="text-xs text-muted">{enterToSend ? t("enterToSendOn") : t("enterToSendOff")}</p>
        </div>
        <Switch
          checked={enterToSend}
          onCheckedChange={setEnterToSend}
          aria-labelledby="settings-enter-to-send-label"
          data-testid="settings-enter-to-send"
        />
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg" id="settings-reduce-motion-label">
            {t("reduceMotion")}
          </p>
          <p className="text-xs text-muted">{t("reduceMotionHint")}</p>
        </div>
        <Switch
          checked={reduceMotion}
          onCheckedChange={setReduceMotion}
          aria-labelledby="settings-reduce-motion-label"
          data-testid="settings-reduce-motion"
        />
      </div>
    </SettingsSection>
  );
}
