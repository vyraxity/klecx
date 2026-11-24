/**
 * @jest-environment jsdom
 *
 * Two-factor sign-in (after Step 10.1): Settings → Security card and the
 * sign-in challenge form.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TwoFactorCard } from "@/components/settings/security/two-factor-card";
import { TwoFactorChallengeForm } from "@/components/auth/TwoFactorChallengeForm";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);

const mockPush = jest.fn();
let mockNext: string | null = "/settings/billing?subscribe=lite";
jest.mock("next/navigation", () => ({
  usePathname: () => "/auth/two-factor",
  useRouter: () => ({ refresh: jest.fn(), push: mockPush, replace: jest.fn() }),
  useSearchParams: () => ({ get: (k: string) => (k === "next" ? mockNext : null) }),
}));

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const mockVerifyTotp = jest.fn();
const mockVerifyBackup = jest.fn();
jest.mock("../lib/auth-client", () => ({
  authClient: {
    twoFactor: {
      verifyTotp: (...a: unknown[]) => mockVerifyTotp(...a),
      verifyBackupCode: (...a: unknown[]) => mockVerifyBackup(...a),
    },
  },
}));

// Radix's checkbox measures itself; jsdom has no ResizeObserver.
global.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const originalFetch = global.fetch;
const calls: { url: string; body: unknown }[] = [];
function mockApi(responses: Record<string, unknown>) {
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(responses).find((k) => u.endsWith(k));
    const data = key ? responses[key] : null;
    if (data instanceof Error) {
      return new Response(JSON.stringify({ error: { code: data.message, message: "x" } }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

afterAll(() => {
  global.fetch = originalFetch;
});
beforeEach(() => {
  calls.length = 0;
  mockPush.mockReset();
});

const CODES = Array.from({ length: 10 }, (_, i) => `abcd${i}-12345`);

describe("Settings → Security: two-factor card", () => {
  test("without a password it can't be turned on and says why", () => {
    render(<TwoFactorCard initial={{ enabled: false, hasPassword: false }} />);
    expect(screen.getByText(/Set a password above first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  test("turning it on: password → QR code and key → first code → backup codes", async () => {
    mockApi({
      "/two-factor/setup": { totpUri: "otpauth://totp/Klecx:a@b.c?secret=JBSWY3DPEHPK3PXP&issuer=Klecx", manualKey: "JBSW Y3DP EHPK 3PXP", backupCodes: CODES },
      "/two-factor/confirm": { enabled: true, hasPassword: true },
    });
    render(<TwoFactorCard initial={{ enabled: false, hasPassword: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("img", { name: /QR code to add Klecx/ })).toBeInTheDocument();
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    expect(calls[0]).toEqual({ url: expect.stringContaining("/api/v1/me/two-factor/setup"), body: { password: "secret-password" } });

    const confirm = screen.getByRole("button", { name: "Turn on" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Code from the app"), { target: { value: "12 34 56" } });
    expect(screen.getByLabelText("Code from the app")).toHaveValue("123456");
    fireEvent.click(confirm);

    const list = await screen.findByRole("list", { name: "Backup codes" });
    expect(list.querySelectorAll("li")).toHaveLength(10);
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(calls[1]).toEqual({ url: expect.stringContaining("/two-factor/confirm"), body: { code: "123456" } });

    fireEvent.click(screen.getByRole("button", { name: "I've saved them" }));
    expect(screen.queryByRole("list", { name: "Backup codes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
  });

  test("turning it off asks for the password; a wrong one keeps it on", async () => {
    mockApi({ "/two-factor/disable": new Error("INVALID_PASSWORD") });
    render(<TwoFactorCard initial={{ enabled: true, hasPassword: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getByText("On")).toBeInTheDocument();
  });
});

describe("sign-in challenge", () => {
  test("a right code goes on to where the person was going", async () => {
    mockVerifyTotp.mockResolvedValue({ data: { token: "x" }, error: null });
    render(<TwoFactorChallengeForm />);
    const input = screen.getByLabelText("Authentication code");
    fireEvent.change(input, { target: { value: "123abc456" } });
    expect(input).toHaveValue("123456");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/settings/billing?subscribe=lite"));
    expect(mockVerifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: true });
  });

  test("a wrong code shows a translated error; an expired challenge offers to sign in again", async () => {
    mockVerifyTotp.mockResolvedValueOnce({ data: null, error: { code: "INVALID_CODE", status: 401 } });
    render(<TwoFactorChallengeForm />);
    fireEvent.change(screen.getByLabelText("Authentication code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right");

    mockVerifyTotp.mockResolvedValueOnce({ data: null, error: { code: "INVALID_TWO_FACTOR_COOKIE", status: 401 } });
    fireEvent.change(screen.getByLabelText("Authentication code"), { target: { value: "111111" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/auth/login");
  });

  test("backup code mode, and never a redirect to another site", async () => {
    mockNext = "https://evil.example/steal";
    mockVerifyBackup.mockResolvedValue({ data: {}, error: null });
    render(<TwoFactorChallengeForm />);
    fireEvent.click(screen.getByRole("button", { name: "Use a backup code instead" }));
    fireEvent.change(screen.getByLabelText("Backup code"), { target: { value: "abcde-12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/workspaces"));
    expect(mockVerifyBackup).toHaveBeenCalledWith({ code: "abcde-12345", trustDevice: false });
    expect(screen.getByText(/Lost your phone/)).toHaveTextContent("support@example.test");
  });
});
