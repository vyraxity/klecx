/**
 * Pre-10.6 fix PR 2 (owner, 2026-11-27): help search from the URL, and the
 * signed-in hint behind "Go to your workspaces" on the marketing pages.
 * Invitation feedback is covered in step-7-4-members.test.ts.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../messages/en.json";
import { HelpCenterView } from "@/components/help/help-center-view";
import { MarketingHeader } from "@/components/marketing/header";
import {
  helpCategoryParam,
  helpQueryParam,
  helpSearchQueryString,
  HELP_QUERY_MAX_LENGTH,
  type HelpArticleMeta,
} from "@/lib/help/shared";
import { SIGNED_IN_HINT_COOKIE } from "@/lib/auth/signed-in-hint-cookie";
import { STORAGE_ITEMS } from "@/lib/legal/cookies";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/",
}));

const article = (slug: string, title: string, categoryKey: string): HelpArticleMeta => ({
  slug,
  title,
  categoryKey,
  description: `${title} description`,
  keywords: [],
  readMinutes: 2,
  isFallback: false,
});

const ARTICLES = [
  article("credits-and-plans", "Credits and plans", "billing-account"),
  article("inviting-people", "Inviting people", "collaboration-sharing"),
  article("first-steps", "First steps", "getting-started"),
];

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe("help search URL parameters", () => {
  test("q is trimmed, capped and takes the first value", () => {
    expect(helpQueryParam("  credits  ")).toBe("credits");
    expect(helpQueryParam(["one", "two"])).toBe("one");
    expect(helpQueryParam(undefined)).toBe("");
    expect(helpQueryParam("x".repeat(500))).toHaveLength(HELP_QUERY_MAX_LENGTH);
  });

  test("category is accepted only when it is a known category", () => {
    expect(helpCategoryParam("troubleshooting")).toBe("troubleshooting");
    expect(helpCategoryParam("not-a-category")).toBeNull();
    expect(helpCategoryParam(undefined)).toBeNull();
  });

  test("the query string is empty without filters and encodes both", () => {
    expect(helpSearchQueryString("", null)).toBe("");
    expect(helpSearchQueryString("  ", null)).toBe("");
    expect(helpSearchQueryString("plans & credits", "troubleshooting")).toBe(
      "?q=plans+%26+credits&category=troubleshooting"
    );
  });
});

describe("help center view", () => {
  afterEach(() => {
    jest.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  test("opens filtered by the query from the URL", () => {
    renderWithIntl(<HelpCenterView articles={ARTICLES} initialQuery="invit" />);
    expect(screen.getByRole("searchbox")).toHaveValue("invit");
    expect(screen.getByText("Inviting people")).toBeInTheDocument();
    expect(screen.queryByText("Credits and plans")).not.toBeInTheDocument();
    expect(screen.queryByText("First steps")).not.toBeInTheDocument();
  });

  test("opens filtered by the category from the URL", () => {
    renderWithIntl(<HelpCenterView articles={ARTICLES} initialCategory="getting-started" />);
    expect(screen.getByText("First steps")).toBeInTheDocument();
    expect(screen.queryByText("Inviting people")).not.toBeInTheDocument();
  });

  test("typing updates the address bar after a pause, without a new history entry", () => {
    jest.useFakeTimers();
    window.history.replaceState(null, "", "/help");
    const lengthBefore = window.history.length;
    renderWithIntl(<HelpCenterView articles={ARTICLES} />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "credits" } });
    expect(window.location.search).toBe("");
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(window.location.pathname).toBe("/help");
    expect(window.location.search).toBe("?q=credits");
    expect(window.history.length).toBe(lengthBefore);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(window.location.search).toBe("");
  });
});

describe("signed-in hint", () => {
  test("the cookie policy lists it", () => {
    expect(STORAGE_ITEMS.some((i) => i.names.includes(SIGNED_IN_HINT_COOKIE))).toBe(true);
  });

  test("the header offers the workspaces only when the hint is there", () => {
    const { unmount } = renderWithIntl(<MarketingHeader />);
    expect(screen.getByRole("link", { name: /Sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Go to your workspaces/i })).not.toBeInTheDocument();
    unmount();

    document.cookie = `${SIGNED_IN_HINT_COOKIE}=1; path=/`;
    try {
      renderWithIntl(<MarketingHeader />);
      const link = screen.getByRole("link", { name: /Go to your workspaces/i });
      expect(link).toHaveAttribute("href", "/workspaces");
      expect(screen.queryByRole("link", { name: /Sign in/i })).not.toBeInTheDocument();
    } finally {
      document.cookie = `${SIGNED_IN_HINT_COOKIE}=; path=/; max-age=0`;
    }
  });
});
