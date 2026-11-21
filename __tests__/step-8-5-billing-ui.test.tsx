/**
 * Step 8.5 — billing page and upgrade dialog (UI).
 * - Settings → Billing: payment-issue banner (PAST_DUE) with the portal button,
 *   the cancel confirmation saying until when the plan is kept, "Keep my plan",
 *   and only upgrades offered in Change plan;
 * - back from checkout: "Activating your plan…" until the webhook activated it;
 * - billing off: no billing actions (rule 9);
 * - the upgrade dialog recommends the cheapest plan that unlocks the gate, and
 *   doesn't open for reasons the person can't fix or while billing is off.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import QueryProvider from "@/components/providers/query-provider";
import { SiteConfigProvider, DEFAULT_PUBLIC_SITE_CONFIG } from "@/components/providers/site-config-provider";
import { BillingSettingsView } from "@/components/settings/billing/billing-settings-view";
import { UpgradeDialogHost } from "@/components/billing/upgrade-dialog";
import { openUpgradeDialog } from "@/lib/billing/upgrade";
import type { MySubscription } from "@/lib/schemas/billing";
import enMessages from "../messages/en.json";

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, refresh: jest.fn() }),
  usePathname: () => "/settings/billing",
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const DAY = 24 * 60 * 60 * 1000;
const periodEnd = new Date(Date.UTC(2030, 0, 15)).toISOString();

function subscription(over: Partial<NonNullable<MySubscription["subscription"]>> = {}): MySubscription["subscription"] {
  return {
    plan: "STANDARD",
    interval: "month",
    status: "ACTIVE",
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    canManage: true,
    canCancel: true,
    canResume: false,
    canChangePlan: true,
    paymentIssue: false,
    ...over,
  };
}

let responses: MySubscription[];
let calls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  mockReplace.mockClear();
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/api/v1/me/subscription")) {
      const next = responses.length > 1 ? responses.shift()! : responses[0];
      return new Response(JSON.stringify({ data: next }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

function renderWithProviders(ui: React.ReactElement, billingEnabled = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <SiteConfigProvider value={{ ...DEFAULT_PUBLIC_SITE_CONFIG, billingEnabled }}>
        <QueryProvider>{ui}</QueryProvider>
      </SiteConfigProvider>
    </NextIntlClientProvider>
  );
}

const view = (props: Partial<React.ComponentProps<typeof BillingSettingsView>> = {}) => (
  <BillingSettingsView userId="u1" checkoutReturned={false} intent={null} {...props} />
);

describe("Step 8.5 — Settings → Billing", () => {
  it("a failed renewal shows the payment-issue banner with the portal button", async () => {
    responses = [{ effectivePlan: "STANDARD", resetsAt: null, balance: 10, subscription: subscription({ status: "PAST_DUE", paymentIssue: true }) }];
    renderWithProviders(view());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Your last payment for Standard failed/);
    fireEvent.click(within(alert).getByRole("button", { name: /Update payment method/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/v1/billing/portal"))).toBe(true));
  });

  it("cancel asks first and says until when the plan is kept", async () => {
    responses = [{ effectivePlan: "STANDARD", resetsAt: null, balance: 900, subscription: subscription() }];
    renderWithProviders(view());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel plan" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("You keep Standard and its credits until January 15, 2030.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel plan" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.includes("/api/v1/billing/cancel"))?.body).toEqual({ atPeriodEnd: true })
    );
  });

  it("a scheduled cancellation shows its end date and Keep my plan", async () => {
    responses = [{ effectivePlan: "STANDARD", resetsAt: null, balance: 900, subscription: subscription({ cancelAtPeriodEnd: true, canCancel: false, canResume: true, canChangePlan: false }) }];
    renderWithProviders(view());
    expect(await screen.findByText("Ends on January 15, 2030")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel plan" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep my plan" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/v1/billing/resume"))).toBe(true));
  });

  it("Change plan offers only upgrades and sends plan + period, never a product or price", async () => {
    responses = [{ effectivePlan: "STANDARD", resetsAt: null, balance: 900, subscription: subscription() }];
    renderWithProviders(view());
    fireEvent.click(await screen.findByRole("button", { name: "Change plan" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Lite")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Pro")).toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Upgrade" })[0]!);
    await waitFor(() =>
      expect(calls.find((c) => c.url.includes("/api/v1/billing/change-plan"))?.body).toEqual({ plan: "PRO", interval: "month" })
    );
  });

  it("back from checkout: Activating… until the webhook activated the plan", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      responses = [
        { effectivePlan: "FREE", resetsAt: null, balance: 100, subscription: null },
        { effectivePlan: "LITE", resetsAt: null, balance: 800, subscription: subscription({ plan: "LITE" }) },
      ];
      renderWithProviders(view({ checkoutReturned: true }));
      expect(await screen.findByText(/Activating your plan/)).toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(2_100);
      });
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/settings/billing"));
      expect(screen.queryByText(/Activating your plan/)).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("back from checkout, no webhook within 60 s: taking longer than usual", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      responses = [{ effectivePlan: "FREE", resetsAt: null, balance: 100, subscription: null }];
      renderWithProviders(view({ checkoutReturned: true }));
      expect(await screen.findByText(/Activating your plan/)).toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(61 * 1000);
      });
      expect(await screen.findByText(/taking longer than usual/)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("billing off: no billing actions, only the launch note", async () => {
    responses = [{ effectivePlan: "FREE", resetsAt: new Date(Date.now() + 5 * DAY).toISOString(), balance: 100, subscription: null }];
    renderWithProviders(view(), false);
    expect(await screen.findByText("Paid plans are launching soon.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade" })).not.toBeInTheDocument();
    expect(screen.queryByText("Request a refund")).not.toBeInTheDocument();
  });

  it("a plan chosen before signing up continues to payment", async () => {
    responses = [{ effectivePlan: "FREE", resetsAt: null, balance: 100, subscription: null }];
    const assign = jest.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = url.includes("/billing/checkout") ? { url: "https://checkout.example/x" } : responses[0];
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    renderWithProviders(view({ intent: { plan: "LITE", interval: "year" } }));
    expect(await screen.findByText(/You chose Lite \(Yearly\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/x"));
    expect(calls.find((c) => c.url.includes("/billing/checkout"))?.body).toEqual({ plan: "LITE", interval: "year" });
  });
});

describe("Step 8.5 — upgrade dialog", () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
  });

  it("recommends the cheapest plan that unlocks the gate", async () => {
    responses = [{ effectivePlan: "FREE", resetsAt: null, balance: 90, subscription: null }];
    renderWithProviders(<UpgradeDialogHost userId="u1" />);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/v1/me/subscription"))).toBe(true));
    act(() => {
      expect(openUpgradeDialog({ code: "requires_plan", plan: "LITE" })).toBe(true);
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Upgrade to Lite");
  });

  it("offers an upgrade once when ≥ 80 % of the credits are used", async () => {
    responses = [{ effectivePlan: "LITE", resetsAt: "2030-01-15T00:00:00.000Z", balance: 100, subscription: subscription({ plan: "LITE" }) }];
    const { unmount } = renderWithProviders(<UpgradeDialogHost userId="u1" />);
    expect(await screen.findByRole("dialog")).toHaveTextContent("Upgrade to Standard");
    unmount();
    renderWithProviders(<UpgradeDialogHost userId="u1" />);
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/api/v1/me/subscription")).length).toBeGreaterThan(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("doesn't open for the owner's plan, or while billing is off", async () => {
    responses = [{ effectivePlan: "FREE", resetsAt: null, balance: 90, subscription: null }];
    renderWithProviders(<UpgradeDialogHost userId="u1" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    act(() => {
      openUpgradeDialog({ code: "owner_plan", plan: "PRO" });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("billing off: no host, nothing opens", () => {
    responses = [{ effectivePlan: "FREE", resetsAt: null, balance: 0, subscription: null }];
    renderWithProviders(<UpgradeDialogHost userId="u1" />, false);
    expect(openUpgradeDialog({ code: "requires_plan", plan: "LITE" })).toBe(false);
  });
});
