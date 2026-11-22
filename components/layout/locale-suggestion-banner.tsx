"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Languages, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LOCALE_COOKIE } from "@/i18n/config";
import {
  LOCALE_SUGGESTION_COOKIE,
  LOCALE_SUGGESTION_MAX_AGE,
  type LocaleSuggestion,
} from "@/lib/i18n/locale-suggestion";

function remember(value: "switched" | "dismissed") {
  document.cookie = `${LOCALE_SUGGESTION_COOKIE}=${value}; path=/; max-age=${LOCALE_SUGGESTION_MAX_AGE}; SameSite=Lax`;
}

/**
 * Step 9.2: "Klecx is also available in Français" — shown once per device
 * (the answer is remembered in a cookie), in the suggested language.
 */
export function LocaleSuggestionBanner({
  suggestion,
  saveToAccount,
}: {
  suggestion: LocaleSuggestion;
  saveToAccount: boolean;
}) {
  const router = useRouter();
  const [hidden, setHidden] = React.useState(false);
  const [switching, startSwitch] = React.useTransition();
  if (hidden) return null;

  const dismiss = () => {
    remember("dismissed");
    setHidden(true);
  };

  const switchLocale = () => {
    remember("switched");
    document.cookie = `${LOCALE_COOKIE}=${suggestion.locale}; path=/; max-age=31536000; SameSite=Lax`;
    startSwitch(async () => {
      if (saveToAccount) {
        await fetch("/api/v1/me/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uiLocale: suggestion.locale }),
        }).catch(() => undefined);
      }
      setHidden(true);
      router.refresh();
    });
  };

  return (
    <div
      role="region"
      aria-label={suggestion.strings.regionLabel}
      lang={suggestion.locale}
      data-testid="locale-suggestion"
      className="fixed inset-x-4 top-3 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-lg"
    >
      <Languages className="h-5 w-5 shrink-0 text-accent" aria-hidden />
      <p className="min-w-0 flex-1 text-sm text-fg">{suggestion.strings.message}</p>
      <Button type="button" size="sm" onClick={switchLocale} disabled={switching}>
        {suggestion.strings.switchLabel}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={dismiss}
        aria-label={suggestion.strings.dismissLabel}
        title={suggestion.strings.dismissLabel}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
