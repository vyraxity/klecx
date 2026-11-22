/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ReadAloudButton } from "@/components/speech/read-aloud-button";
import { resetReadAloudForTesting, useReadAloud } from "@/lib/speech/player-store";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }));

const spoken: string[] = [];
beforeAll(() => {
  // A browser voice that keeps "speaking" until cancelled.
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: (u: { text: string }) => spoken.push(u.text),
    cancel: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    paused: false,
    getVoices: () => [],
  };
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
    text: string;
    rate = 1;
    lang = "";
    voice: unknown;
    onend: unknown;
    onerror: unknown;
    constructor(text: string) {
      this.text = text;
    }
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
  spoken.length = 0;
});

const target = { type: "ANNOTATION_MESSAGE" as const, id: "m1" };

describe("Step 9.4 — read-aloud keyboard focus", () => {
  it("moves focus to Pause when reading starts, and back to Read aloud after Escape", async () => {
    render(<ReadAloudButton target={target} />);
    const readButton = screen.getByRole("button", { name: "Read aloud" });
    readButton.focus();
    fireEvent.click(readButton);

    const pause = await screen.findByRole("button", { name: "Pause" });
    await waitFor(() => expect(document.activeElement).toBe(pause));
    expect(spoken).toEqual(["First part."]);
    expect(screen.getByRole("group", { name: "Read-aloud player" })).toBeInTheDocument();

    fireEvent.keyDown(pause, { key: "Escape" });
    const back = await screen.findByRole("button", { name: "Read aloud" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(useReadAloud.getState().status).toBe("idle");
  });

  it("Stop returns focus to Read aloud", async () => {
    render(<ReadAloudButton target={target} />);
    const readButton = screen.getByRole("button", { name: "Read aloud" });
    readButton.focus();
    fireEvent.click(readButton);
    const stop = await screen.findByRole("button", { name: "Stop reading" });
    stop.focus();
    fireEvent.click(stop);
    const back = await screen.findByRole("button", { name: "Read aloud" });
    await waitFor(() => expect(document.activeElement).toBe(back));
  });

  it("doesn't steal focus when reading ends while the person is elsewhere", async () => {
    render(
      <>
        <ReadAloudButton target={target} />
        <input aria-label="Elsewhere" />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    await screen.findByRole("button", { name: "Pause" });
    const elsewhere = screen.getByLabelText("Elsewhere");
    elsewhere.focus();
    act(() => useReadAloud.getState().stop());
    await screen.findByRole("button", { name: "Read aloud" });
    expect(document.activeElement).toBe(elsewhere);
  });
});
