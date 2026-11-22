"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { cn } from "@/lib/utils";

const THEMES: { value: "system" | "light" | "dark"; icon: LucideIcon }[] = [
  { value: "system", icon: Monitor },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
];

const noopSubscribe = () => () => {};

/**
 * Step 9.1: the theme (system / light / dark). Kept on this device for now;
 * Step 9.2 saves it on the account so other devices follow.
 */
export function ThemeCard() {
  const t = useTranslations("Settings.appearance");
  const { theme, setTheme } = useTheme();
  // The theme is only known in the browser: render nothing selected on the
  // server and the first client render, so the HTML matches.
  const mounted = React.useSyncExternalStore(noopSubscribe, () => true, () => false);
  const value = mounted ? (theme ?? "system") : undefined;

  return (
    <SettingsSection title={t("themeTitle")} description={t("themeHint")} data-testid="settings-theme">
      <RadioGroup
        value={value}
        onValueChange={setTheme}
        aria-label={t("themeTitle")}
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {THEMES.map(({ value: v, icon: Icon }) => {
          const id = `settings-theme-${v}`;
          return (
            <label
              key={v}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors",
                value === v ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2"
              )}
            >
              <RadioGroupItem id={id} value={v} />
              <Icon className="h-4 w-4 text-muted" aria-hidden />
              <span className="font-medium text-fg">{t(`theme.${v}`)}</span>
            </label>
          );
        })}
      </RadioGroup>
    </SettingsSection>
  );
}
