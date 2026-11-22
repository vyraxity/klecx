"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { SettingsSection } from "@/components/settings/settings-section";
import { useUpdateUserPreferences, useUserPreferences } from "@/lib/api/hooks/me";
import { localeNames, locales, type Locale } from "@/i18n/config";

const AUTO = "auto";

/**
 * Step 9.1: the app's language. Saved on the account (`uiLocale`), so it
 * follows the person to other devices; "Automatic" clears it and the
 * browser's language decides again.
 */
export function AppLanguageCard({
  userId,
  initialUiLocale,
}: {
  userId: string;
  initialUiLocale: string | null;
}) {
  const t = useTranslations("Settings.language");
  const current = useLocale() as Locale;
  const router = useRouter();
  const { data } = useUserPreferences(userId);
  const update = useUpdateUserPreferences(userId);
  const [refreshing, startRefresh] = React.useTransition();
  const saved = data ? data.uiLocale : initialUiLocale;
  const value = saved && (locales as readonly string[]).includes(saved) ? saved : AUTO;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value === AUTO ? null : (e.target.value as Locale);
    update.mutate(
      { uiLocale: next },
      {
        onSuccess: () => startRefresh(() => router.refresh()),
        onError: () => toast.error(t("saveError")),
      }
    );
  };

  const busy = update.isPending || refreshing;

  return (
    <SettingsSection title={t("appTitle")} description={t("appHint")} data-testid="settings-app-language">
      <div className="flex flex-col gap-2">
        <label htmlFor="settings-app-language" className="text-xs font-semibold text-fg">
          {t("appLabel")}
        </label>
        <div className="flex items-center gap-2">
          <select
            id="settings-app-language"
            value={value}
            onChange={onChange}
            disabled={busy}
            className="w-full max-w-xs cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value={AUTO}>{t("automatic")}</option>
            {locales.map((loc) => (
              <option key={loc} value={loc}>
                {localeNames[loc]}
              </option>
            ))}
          </select>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted" aria-hidden />}
        </div>
        {value === AUTO && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-full border border-border bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
              {t("detectedBadge")}
            </span>
            {t("detectedHint", { language: localeNames[current] })}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
