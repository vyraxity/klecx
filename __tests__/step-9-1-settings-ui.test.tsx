/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { NameForm } from "@/components/settings/profile/name-form";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);

let mockPathname = "/settings/security";
const mockRefresh = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ refresh: mockRefresh, push: jest.fn(), replace: jest.fn() }),
}));

const originalFetch = global.fetch;

describe("Step 9.1 — Settings UI", () => {
  afterAll(() => {
    global.fetch = originalFetch;
  });

  test("the nav links every page and marks the current one", () => {
    mockPathname = "/settings/security";
    render(<SettingsNav />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = nav.querySelectorAll("a");
    expect(Array.from(links).map((a) => a.getAttribute("href"))).toEqual([
      "/settings/profile",
      "/settings/security",
      "/settings/sessions",
      "/settings/language",
      "/settings/appearance",
      "/settings/voice",
      "/settings/notifications",
      "/settings/usage",
      "/settings/billing",
      "/settings/data",
      "/settings/deleted",
      "/settings/support",
    ]);
    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Profile" })).not.toHaveAttribute("aria-current");
  });

  test("the name form saves only when changed, and says so", async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ data: { name: "Ada L." } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;

    render(<NameForm initialName="Ada" />);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada L." } });
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/v1/me", expect.objectContaining({ method: "PATCH" })));
    await waitFor(() => expect(screen.queryByText("You have unsaved changes.")).not.toBeInTheDocument());
    expect(mockRefresh).toHaveBeenCalled();
  });

  test("an empty name can't be saved", () => {
    render(<NameForm initialName="Ada" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Enter your name.")).toBeInTheDocument();
  });
});
