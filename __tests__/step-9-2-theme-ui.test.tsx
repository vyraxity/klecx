/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ThemeProvider, useTheme } from "@/components/providers/theme-provider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

function mockColorScheme(dark: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: query.includes("dark") ? dark : false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

function resetHtml() {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.removeAttribute("data-theme-pref");
  document.cookie = "theme=; max-age=0; path=/";
  localStorage.clear();
}

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme ?? "unknown"}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
    </div>
  );
}

describe("Step 9.2 — theme without flash", () => {
  beforeEach(() => {
    resetHtml();
    global.fetch = jest.fn(async () => new Response("{}")) as unknown as typeof fetch;
  });

  it("the head script resolves 'system' from the device before paint", () => {
    mockColorScheme(true);
    document.documentElement.setAttribute("data-theme-pref", "system");
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("the head script keeps an older next-themes choice when there is no cookie yet", () => {
    mockColorScheme(false);
    localStorage.setItem("theme", "dark");
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("setTheme updates the page and the cookie, and saves it on the account when signed in", async () => {
    mockColorScheme(false);
    document.documentElement.setAttribute("data-theme-pref", "light");
    document.documentElement.setAttribute("data-theme", "light");
    render(
      <ThemeProvider initialTheme="light" cookieTheme="light" saveToAccount>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    await act(async () => {
      fireEvent.click(screen.getByText("dark"));
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.cookie).toContain("theme=dark");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/me/preferences",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ theme: "dark" }) })
    );
  });

  it("signed out: no account call", async () => {
    mockColorScheme(false);
    render(
      <ThemeProvider initialTheme={null} cookieTheme={null} saveToAccount={false}>
        <Probe />
      </ThemeProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByText("dark"));
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.cookie).toContain("theme=dark");
  });

  it("aligns this device's cookie with the account's theme after load", () => {
    mockColorScheme(false);
    document.documentElement.setAttribute("data-theme-pref", "dark");
    document.documentElement.setAttribute("data-theme", "dark");
    render(
      <ThemeProvider initialTheme="dark" cookieTheme="light" saveToAccount>
        <Probe />
      </ThemeProvider>
    );
    expect(document.cookie).toContain("theme=dark");
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
  });
});
