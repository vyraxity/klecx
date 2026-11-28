"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Globe, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  useUpdateUserPreferences,
  useUserPreferences,
} from "@/lib/api/hooks/me";
import { AI_LANGUAGES, AI_LANGUAGE_NATIVE_NAMES, type AiLanguage } from "@/lib/locale";
import { useEntitlements } from "@/lib/api/hooks/entitlements";
import { getClientModels } from "@/lib/ai/model-catalog";
import { DEFAULT_MODEL_CHOICES, isDefaultModelChoice } from "@/lib/ai/default-model";
import { PLANS } from "@/server/billing/plans";

export interface AiPreferencesProps {
  userId: string;
  initialWebSearchEnabled?: boolean;
  initialAiLanguage?: string | null;
  /** Pre-10.6 fix: the saved default model (null = Automatic). */
  initialDefaultModelKey?: string | null;
}

export default function AiPreferences({
  userId,
  initialWebSearchEnabled = true,
  initialAiLanguage = null,
  initialDefaultModelKey = null,
}: AiPreferencesProps) {
  const t = useTranslations("Settings.ai");
  const tModels = useTranslations("Models");
  const tPlans = useTranslations();
  const { entitlements, isSuccess: entitlementsLoaded } = useEntitlements();
  const { data: preferences } = useUserPreferences(userId);
  const update = useUpdateUserPreferences(userId);

  const webSearchEnabled =
    preferences?.webSearchEnabled ?? initialWebSearchEnabled;
  const currentLanguage =
    preferences?.aiLanguage !== undefined
      ? preferences.aiLanguage
      : initialAiLanguage;

  const isUpdating = update.isPending;

  // Pre-10.6 fix: the default model for new messages. Only models the
  // person's own plan offers; in someone else's workspace the owner's plan
  // still decides (the composer falls back to what it includes).
  const currentDefaultModel =
    preferences?.defaultModelKey !== undefined
      ? preferences.defaultModelKey
      : isDefaultModelChoice(initialDefaultModelKey)
        ? initialDefaultModelKey
        : null;
  const modelOptions = getClientModels((key, values) => tModels(key, values), "TEXT")
    .filter((m) => (DEFAULT_MODEL_CHOICES as readonly string[]).includes(m.key))
    .map((m) => ({
      ...m,
      // Until the plan is known nothing is locked (the server re-checks).
      locked: entitlementsLoaded && !(entitlements.models as readonly string[]).includes(m.key),
    }));

  const handleDefaultModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    update.mutate(
      { defaultModelKey: isDefaultModelChoice(val) ? val : null },
      {
        onSuccess: () => toast.success(t("defaultModelUpdatedToast")),
        onError: () => toast.error(t("saveError")),
      }
    );
  };

  const languageOptions = AI_LANGUAGES.map((code) => ({
    code,
    label: `${AI_LANGUAGE_NATIVE_NAMES[code]} (${code.toUpperCase()})`,
  }));

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value.trim();
    const nextLang = val ? (val as AiLanguage) : null;
    update.mutate(
      { aiLanguage: nextLang },
      {
        onSuccess: () => toast.success(t("languageUpdatedToast")),
        onError: () => toast.error(t("saveError")),
      }
    );
  };

  const handleToggle = (checked: boolean) => {
    update.mutate(
      { webSearchEnabled: checked },
      {
        onSuccess: () =>
          toast.success(checked ? t("searchOnToast") : t("searchOffToast")),
        onError: () => toast.error(t("saveError")),
      }
    );
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 sm:p-5 shadow-xs">
      <div>
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-bold tracking-tight text-fg">
            {t("title")}
          </h3>
        </div>
        <p className="text-xs text-muted mt-0.5">
          {t("subtitle")}
        </p>
      </div>

      {/* Default model for new messages (pre-10.6 fix) */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-surface-2/40 p-3">
        <label
          htmlFor="settings-default-model-select"
          className="text-xs font-semibold text-fg"
        >
          {t("defaultModelLabel")}
        </label>
        <select
          id="settings-default-model-select"
          data-testid="settings-default-model-select"
          aria-describedby="settings-default-model-hint"
          value={currentDefaultModel ?? ""}
          onChange={handleDefaultModelChange}
          disabled={isUpdating}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-fg focus:outline-none focus:ring-1 focus:ring-accent cursor-pointer transition-colors"
        >
          <option value="">{t("defaultModelAutomatic")}</option>
          {modelOptions.map((m) => (
            <option key={m.key} value={m.key} disabled={m.locked}>
              {m.locked
                ? t("defaultModelLocked", {
                    model: m.name,
                    plan: tPlans(PLANS[m.minPlan].name),
                  })
                : `${m.name} · ${m.creditHint}`}
            </option>
          ))}
        </select>
        <p id="settings-default-model-hint" className="text-[11px] text-muted">
          {t("defaultModelHint")}
        </p>
      </div>

      {/* Language Klecx answers in */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-surface-2/40 p-3">
        <label
          htmlFor="settings-ai-language-select"
          className="text-xs font-semibold text-fg"
        >
          {t("languageLabel")}
        </label>
        <select
          id="settings-ai-language-select"
          data-testid="settings-ai-language-select"
          value={currentLanguage || ""}
          onChange={handleLanguageChange}
          disabled={isUpdating}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-fg focus:outline-none focus:ring-1 focus:ring-accent cursor-pointer transition-colors"
        >
          <option value="">{t("auto")}</option>
          {languageOptions.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Search the web switch */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-surface-2/40 p-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-fg">
            {t("searchLabel")}
          </span>
          <span className="text-[11px] text-muted">
            {t("searchHint")}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isUpdating && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
          <Switch
            checked={webSearchEnabled}
            onCheckedChange={handleToggle}
            disabled={isUpdating}
            data-testid="settings-web-search-toggle"
            aria-label={t("searchLabel")}
          />
        </div>
      </div>
    </div>
  );
}
