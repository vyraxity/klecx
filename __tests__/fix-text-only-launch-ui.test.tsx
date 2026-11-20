/**
 * Text-only launch (owner decided 2026-11-20) — the UI while image generation is off:
 * no image mode in the composer, no image starters, no image lines on the pricing
 * page, and no Regenerate on an existing image answer. With the switch on, the
 * same components show them again (the existing F4.4 / marketing tests cover that).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import QueryProvider, { createAppQueryClient } from "@/components/providers/query-provider";
import { entitlementsForPlan } from "@/lib/entitlements/shared";
import { Composer } from "@/components/workspace/composer";
import { StarterLibrary } from "@/components/home/starter-library";
import { ResponseCard } from "@/components/response/response-card";
import { MarketingPricingTable } from "@/components/marketing/pricing-table";
import enMessages from "../messages/en.json";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/workspaces",
}));

const FLAG = "NEXT_PUBLIC_IMAGE_GENERATION_ENABLED";

function renderUi(ui: React.ReactElement) {
  const queryClient = createAppQueryClient();
  queryClient.setQueryData(["me", "entitlements"], entitlementsForPlan("PRO"));
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueryProvider client={queryClient}>{ui}</QueryProvider>
    </NextIntlClientProvider>
  );
}

beforeAll(() => {
  window.scrollTo = jest.fn();
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
  );
});
beforeEach(() => {
  process.env[FLAG] = "false";
});
afterAll(() => {
  process.env[FLAG] = "true"; // jest.setup default
});

describe("Text-only launch — UI with image generation off", () => {
  it("the composer has no image mode, even on Pro", () => {
    renderUi(<Composer />);
    expect(screen.queryByTestId("mode-tab-image")).not.toBeInTheDocument();
    expect(screen.queryByText(enMessages.Chat.modeImage)).not.toBeInTheDocument();
  });

  it("the composer shows the image mode again when the switch is on", () => {
    process.env[FLAG] = "true";
    renderUi(<Composer />);
    expect(screen.getByTestId("mode-tab-image")).toBeInTheDocument();
  });

  it("the starter library has no image category", () => {
    renderUi(<StarterLibrary onUseTemplate={jest.fn()} />);
    expect(screen.queryByText(enMessages.Templates.catImage)).not.toBeInTheDocument();
    expect(screen.getByText(enMessages.Templates.catWrite)).toBeInTheDocument();
  });

  it("the pricing table lists no image feature or image cost", () => {
    renderUi(<MarketingPricingTable />);
    expect(screen.queryByText(enMessages.Plans.PRO.features.images)).not.toBeInTheDocument();
    expect(screen.queryByText(enMessages.Marketing.pricing.imageGenTitle)).not.toBeInTheDocument();
  });

  it("an existing image answer has no Regenerate; a text answer keeps it", () => {
    const base = {
      workspaceId: "ws-1",
      prompt: "p",
      activeVersionId: "ver-1",
    };
    const { unmount } = renderUi(
      <ResponseCard
        response={{
          ...base,
          id: "res-img",
          kind: "IMAGE",
          content: "https://res.cloudinary.com/x/image.png",
          activeVersion: { id: "ver-1", number: 1, content: "https://res.cloudinary.com/x/image.png" },
        }}
        workspaceId="ws-1"
        userId="user-1"
        canGenerate
        onRegenerate={jest.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /Regenerate/i })).not.toBeInTheDocument();
    unmount();

    renderUi(
      <ResponseCard
        response={{
          ...base,
          id: "res-txt",
          content: "Text answer",
          activeVersion: { id: "ver-2", number: 1, content: "Text answer" },
        }}
        workspaceId="ws-1"
        userId="user-1"
        canGenerate
        onRegenerate={jest.fn()}
      />
    );
    expect(screen.getAllByRole("button", { name: /Regenerate/i }).length).toBeGreaterThan(0);
  });
});
