/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { ReadAloudButton } from "@/components/speech/read-aloud-button";
import { ReadAloudDock } from "@/components/speech/read-aloud-dock";
import { resetReadAloudForTesting, useReadAloud } from "@/lib/speech/player-store";
import { scrollBehavior } from "@/lib/a11y/motion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VoiceSettings } from "@/components/settings/voice/voice-settings";
import { DEFAULT_PUBLIC_SITE_CONFIG, SiteConfigProvider } from "@/components/providers/site-config-provider";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }));

/**
 * Step 10.5 — read-aloud accessibility (carried from Step 9.4): every player
 * control is reachable with Tab and named, the part counter reads "Part 1 of
 * 2", the speed button says its value, state changes are announced once in a
 * polite status region, and scripted scrolling respects reduced motion.
 */
beforeAll(() => {
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: jest.fn(),
    cancel: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    paused: false,
    getVoices: () => [],
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
    rate = 1;
    lang = "";
    constructor(public text: string) {}
  };
  global.fetch = jest.fn(async () =>
    new Response(
      JSON.stringify({
        data: {
          provider: "browser",
          voiceId: null,
          speed: 1,
          truncated: false,
          segments: [
            { index: 0, text: "First part.", chars: 11, cached: false },
            { index: 1, text: "Second part.", chars: 12, cached: false },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  ) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => resetReadAloudForTesting());
});

function Page() {
  return (
    <>
      <ReadAloudButton target={{ type: "ANNOTATION_MESSAGE", id: "m1" }} />
      <ReadAloudDock />
    </>
  );
}

describe("Step 10.5 — read-aloud accessibility", () => {
  /** What Tab reaches in the player, in order (focusable, enabled, not tabindex=-1). */
  function tabStops(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>("button, a[href], input, select, [tabindex]")).filter(
      (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("tabindex") !== "-1"
    );
  }

  it("every player control is a Tab stop with a name", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    const player = await screen.findByRole("group", { name: "Read-aloud player" });
    await waitFor(() => expect(document.activeElement).toBe(within(player).getByRole("button", { name: "Pause" })));
    // "Previous part" is disabled on the first part.
    const names = tabStops(player).map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim());
    expect(names).toEqual(["Go to the text being read", "Pause", "Next part", "Speed: 1×", "Stop reading", "Voice settings"]);
    for (const el of tabStops(player)) {
      el.focus();
      expect(document.activeElement).toBe(el);
    }
  });

  it("buttons work from the keyboard (native buttons: Enter and Space click)", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    const player = await screen.findByRole("group", { name: "Read-aloud player" });
    for (const el of tabStops(player)) {
      if (el.tagName === "BUTTON") expect(el).toHaveAttribute("type", "button");
    }
    fireEvent.click(within(player).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(useReadAloud.getState().status).toBe("paused"));
    fireEvent.click(within(player).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(useReadAloud.getState().status).not.toBe("paused"));
    fireEvent.click(within(player).getByRole("button", { name: "Next part" }));
    await waitFor(() => expect(useReadAloud.getState().index).toBe(1));
  });

  it("labels the part counter for screen readers", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    const player = await screen.findByRole("group", { name: "Read-aloud player" });
    expect(within(player).getByText("Part 1 of 2")).toHaveClass("sr-only");
    expect(within(player).getByText("1/2")).toHaveAttribute("aria-hidden");
  });

  it("announces start, pause, resume and stop once each, politely", async () => {
    render(<Page />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    await waitFor(() => expect(status).toHaveTextContent("Reading aloud"));
    act(() => useReadAloud.getState().pause());
    await waitFor(() => expect(status).toHaveTextContent("Reading paused"));
    act(() => useReadAloud.getState().resume());
    await waitFor(() => expect(status).toHaveTextContent("Reading resumed"));
    act(() => useReadAloud.getState().stop());
    // Still mounted after the player closes, so "stopped" is heard.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Reading stopped"));
  });

  it("scripted scrolling is instant when motion is reduced", () => {
    expect(scrollBehavior()).toBe("smooth");
    document.documentElement.dataset.reduceMotion = "true";
    expect(scrollBehavior()).toBe("auto");
    delete document.documentElement.dataset.reduceMotion;
  });
});

// ── Settings → Voice ────────────────────────────────────────────────────────

describe("Step 10.5 — Settings → Voice accessibility", () => {
  function renderVoice(overview: Record<string, unknown>) {
    (global.fetch as jest.Mock).mockImplementationOnce(async () =>
      new Response(JSON.stringify({ data: overview }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <SiteConfigProvider value={{ ...DEFAULT_PUBLIC_SITE_CONFIG, billingEnabled: false }}>
          <VoiceSettings userId="u1" />
        </SiteConfigProvider>
      </QueryClientProvider>
    );
  }

  it("explains the disabled natural option and announces the speed value", async () => {
    renderVoice({ provider: "browser", voiceId: null, speed: 1.25, naturalAllowed: false, voices: [], dailyLimitSeconds: 0, usedTodaySeconds: 0 });
    const group = await screen.findByRole("radiogroup");
    const natural = within(group).getAllByRole("radio").find((r) => r.hasAttribute("disabled"))!;
    expect(natural).toHaveAttribute("aria-describedby", "voice-natural-plan");
    expect(document.getElementById("voice-natural-plan")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "1.25×");
  });

  it("gives every voice sample button its own name", async () => {
    renderVoice({
      provider: "natural",
      voiceId: "a",
      speed: 1,
      naturalAllowed: true,
      voices: [
        { id: "a", number: 1, style: "bright" },
        { id: "b", number: 2, style: "calm" },
      ],
      dailyLimitSeconds: 1800,
      usedTodaySeconds: 0,
    });
    const groups = await screen.findAllByRole("radiogroup");
    const samples = within(groups[1]!).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(new Set(samples).size).toBe(2);
  });
});
