"use client";

import React, { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Locale, LOCALE_COOKIE, localeNames, locales } from "@/i18n/config";
import { Globe } from "lucide-react";

export interface LocaleSwitcherProps {
  compact?: boolean;
  className?: string;
  /**
   * Signed-in pages: also save the choice on the account (`uiLocale`), which
   * wins over the cookie on the server and follows the person to other devices.
   */
  saveToAccount?: boolean;
}

export const LocaleSwitcher: React.FC<LocaleSwitcherProps> = ({
  compact = false,
  className = "",
  saveToAccount = false,
}) => {
  const t = useTranslations("Common");
  const currentLocale = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleLocaleChange = (newLocale: Locale) => {
    if (newLocale === currentLocale) return;
    document.cookie = `${LOCALE_COOKIE}=${newLocale}; path=/; max-age=31536000; SameSite=Lax`;
    startTransition(async () => {
      if (saveToAccount) {
        // Best effort: the cookie above already switches this device.
        await fetch("/api/v1/me/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uiLocale: newLocale }),
        }).catch(() => undefined);
      }
      router.refresh();
    });
  };

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/80 backdrop-blur-md px-2.5 py-1.5 text-xs font-medium text-fg shadow-2xs transition-all ${
        isPending ? "opacity-60 pointer-events-none" : ""
      } ${className}`}
    >
      <Globe className="h-4 w-4 text-accent shrink-0" strokeWidth={1.5} />
      <select
        aria-label={t("selectLanguage")}
        value={currentLocale}
        onChange={(e) => handleLocaleChange(e.target.value as Locale)}
        disabled={isPending}
        className="bg-transparent text-xs font-semibold text-fg focus:outline-none cursor-pointer pe-1"
      >
        {locales.map((loc) => (
          <option key={loc} value={loc} className="bg-surface text-fg">
            {compact ? loc.toUpperCase() : localeNames[loc]}
          </option>
        ))}
      </select>
    </div>
  );
};

export default LocaleSwitcher;
