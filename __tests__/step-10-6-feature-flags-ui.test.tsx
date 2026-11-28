/**
 * Step 10.6: what people see while a feature is paused — the app-wide banner for
 * the AI kill switch and the "paused" tooltip on disabled controls, in every language.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiPausedBanner } from "@/components/layout/ai-paused-banner";
import { gateMessage } from "@/components/ui/gated";
import { FEATURES_QUERY_KEY } from "@/lib/api/hooks/features";
import { ALL_FEATURES_ON } from "@/lib/features/flags";
import enMessages from "../messages/en.json";
import esMessages from "../messages/es.json";
import frMessages from "../messages/fr.json";

function renderBanner(ai: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(FEATURES_QUERY_KEY, { ...ALL_FEATURES_ON, ai });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AiPausedBanner />
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

describe("AI paused banner", () => {
  it("is hidden while AI is on", () => {
    renderBanner(true);
    expect(screen.queryByTestId("ai-paused-banner")).toBeNull();
  });

  it("says AI is paused, as a status message", () => {
    renderBanner(false);
    const banner = screen.getByTestId("ai-paused-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(enMessages.FeaturePause.aiTitle);
  });
});

describe("translations", () => {
  it.each([
    ["en", enMessages],
    ["es", esMessages],
    ["fr", frMessages],
  ])("%s has every paused message", (_locale, messages) => {
    const m = messages as typeof enMessages;
    expect(m.Errors.api.ai_paused).toBeTruthy();
    expect(m.Errors.api.feature_paused).toBeTruthy();
    expect(m.Auth.errors.SIGNUPS_PAUSED).toBeTruthy();
    expect(m.Gates.paused).toBeTruthy();
    expect(m.FeaturePause.aiTitle).toBeTruthy();
    expect(m.FeaturePause.aiText).toBeTruthy();
  });

  it("the gate message for a paused control", () => {
    const t = ((key: string) => (enMessages.Gates as Record<string, string>)[key]) as never;
    expect(gateMessage({ code: "paused" }, t, (k: string) => k)).toBe(enMessages.Gates.paused);
  });
});
