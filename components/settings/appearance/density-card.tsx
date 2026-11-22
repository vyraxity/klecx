"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SettingsSection } from "@/components/settings/settings-section";
import { useUpdateUserPreferences, useUserPreferences } from "@/lib/api/hooks/me";
import { DENSITIES, type Density } from "@/lib/theme";
import { cn } from "@/lib/utils";

function applyDensity(density: Density) {
  if (density === "compact") document.documentElement.setAttribute("data-density", "compact");
  else document.documentElement.removeAttribute("data-density");
}

/**
 * Step 9.2: spacing density, saved on the account. Compact tightens spacing
 * on tablets and computers only (phones keep full-size tap targets).
 */
export function DensityCard({ userId, initialDensity }: { userId: string; initialDensity: Density }) {
  const t = useTranslations("Settings.appearance");
  const { data } = useUserPreferences(userId);
  const update = useUpdateUserPreferences(userId);
  const value = data?.density ?? initialDensity;

  const onChange = (next: string) => {
    const density = DENSITIES.find((d) => d === next);
    if (!density || density === value) return;
    const previous = value;
    applyDensity(density);
    update.mutate(
      { density },
      {
        onError: () => {
          applyDensity(previous);
          toast.error(t("saveError"));
        },
      }
    );
  };

  return (
    <SettingsSection title={t("densityTitle")} description={t("densityHint")} data-testid="settings-density">
      <RadioGroup
        value={value}
        onValueChange={onChange}
        aria-label={t("densityTitle")}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {DENSITIES.map((d) => {
          const id = `settings-density-${d}`;
          return (
            <label
              key={d}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors",
                value === d ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2"
              )}
            >
              <RadioGroupItem id={id} value={d} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block font-medium text-fg">{t(`density.${d}`)}</span>
                <span className="block text-xs text-muted">{t(`density.${d}Hint`)}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </SettingsSection>
  );
}
