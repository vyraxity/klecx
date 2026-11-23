/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { YourDataSettings } from "@/components/settings/data/your-data-settings";

jest.mock("next-intl", () => jest.requireActual("../test-utils/next-intl").nextIntlMock);
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const originalFetch = global.fetch;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let deletion: Record<string, unknown>;
let deleteResponses: Array<[number, unknown]>;
const deleteBodies: unknown[] = [];

beforeEach(() => {
  deleteBodies.length = 0;
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/v1/me/exports") && (!init?.method || init.method === "GET")) {
      return json(200, {
        data: {
          nextAllowedAt: null,
          exports: [
            { id: "e1", status: "READY", createdAt: "2026-11-23T10:00:00Z", expiresAt: "2026-11-24T10:00:00Z", bytes: 10, filesIncluded: 2, filesSkipped: 1 },
          ],
        },
      });
    }
    if (u.endsWith("/api/v1/me/account/deletion") && init?.method === "POST") {
      deleteBodies.push(JSON.parse(String(init.body)));
      const [status, body] = deleteResponses.shift()!;
      return json(status, body);
    }
    if (u.endsWith("/api/v1/me/account/deletion")) return json(200, { data: deletion });
    return json(404, { error: { code: "not_found" } });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <YourDataSettings userId="u1" />
    </QueryClientProvider>
  );
}

describe("Step 9.5 — Settings → Your data", () => {
  it("lists the export with its download link and the files left out", async () => {
    deletion = { email: "a@example.com", hasPassword: true, graceDays: 30, blockers: [], subscription: null };
    renderPage();
    const link = await screen.findByRole("link", { name: /Download/ });
    expect(link).toHaveAttribute("href", "/api/v1/me/exports/e1/download");
    expect(screen.getByText(/1 file is too large/)).toBeInTheDocument();
  });

  it("can't delete while shared workspaces remain; shows each with its state", async () => {
    deletion = {
      email: "a@example.com",
      hasPassword: true,
      graceDays: 30,
      blockers: [
        { type: "workspace", id: "w1", name: "Team plan", memberCount: 2, pendingTransfer: null },
        { type: "project", id: "p1", name: "Research", memberCount: 1, pendingTransfer: { toUserName: "Bola", expiresAt: "2026-11-30T00:00:00Z" } },
      ],
      subscription: null,
    };
    renderPage();
    const blockers = await screen.findByTestId("deletion-blockers");
    expect(within(blockers).getByRole("link", { name: "Team plan" })).toHaveAttribute("href", "/workspaces/w1");
    expect(within(blockers).getByText(/2 members/)).toBeInTheDocument();
    expect(within(blockers).getByText(/Waiting for Bola to accept/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete my account…" })).toBeDisabled();
  });

  it("asks for the email, then the password when the sign-in isn't fresh", async () => {
    deletion = { email: "a@example.com", hasPassword: true, graceDays: 30, blockers: [], subscription: { plan: "LITE", periodEnd: "2026-12-10T00:00:00Z" } };
    deleteResponses = [
      [403, { error: { code: "FRESH_LOGIN_REQUIRED" } }],
      [403, { error: { code: "INVALID_PASSWORD" } }],
    ];
    renderPage();
    expect(await screen.findByText(/the plan ends on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete my account…" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete my account" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Type your email address/), { target: { value: "A@example.com" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/enter your password/);
    fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "wrong" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("That password isn't right."));
    expect(deleteBodies).toEqual([{ confirmEmail: "A@example.com" }, { confirmEmail: "A@example.com", password: "wrong" }]);
  });
});
