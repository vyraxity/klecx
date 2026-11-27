"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useSiteConfig } from "@/components/providers/site-config-provider";
import { Sparkles } from "lucide-react";
import { Composer, type ComposerPrefill } from "@/components/workspace/composer";

const noopSubscribe = () => () => {};
const currentHour = () => new Date().getHours();

export interface GreetingSectionProps {
  userName: string;
  userId?: string;
  /** A starter template to put in the composer (F4.3). */
  prefill?: ComposerPrefill | null;
  credits?: { plan: string; balance: number };
}

export function GreetingSection({
  userName,
  userId,
  prefill,
  credits,
}: GreetingSectionProps) {
  const tHome = useTranslations("Home");
  const site = useSiteConfig();

  // The hour is the browser's: unknown on the server and during hydration
  // (the welcome line), then the time-of-day greeting. Computing it during
  // render made server and browser disagree across time zones (Step 9.2).
  const hour = React.useSyncExternalStore(noopSubscribe, currentHour, () => null);
  const name = userName ? userName.split(" ")[0] : "";
  const greeting =
    hour === null
      ? tHome("greetingDefault", { name: name || "there" })
      : hour < 12
        ? tHome("greetingMorning", { name: name || "there" })
        : hour < 18
          ? tHome("greetingAfternoon", { name: name || "there" })
          : tHome("greetingEvening", { name: name || "there" });

  return (
    <section className="flex flex-col items-center justify-center text-center max-w-3xl mx-auto w-full pt-4 pb-2">
      <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent mb-3 border border-border">
        <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span>{tHome("studioBadge", { appName: site.appName })}</span>
      </div>

      <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-fg mb-6">
        {greeting}
      </h1>

      <div className="w-full text-start">
        <Composer
          size="large"
          prefill={prefill}
          autoFocus={false}
          credits={credits}
          userId={userId}
        />
      </div>
    </section>
  );
}

export default GreetingSection;
