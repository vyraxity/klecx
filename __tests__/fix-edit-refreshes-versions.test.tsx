/**
 * Fix (found by the Step 10.4 journeys, 2026-11-25): a response card shows its
 * version from the versions list (`queryKeys.responses.versions`), which
 * saving or reverting an edit didn't refresh, so an edit saved right after a
 * regeneration stayed invisible until a reload. Saving, reverting and saving
 * review fixes now refresh those lists too.
 */
import React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/hooks/query-keys";
import { useCreateResponseEdit, useCreateVersionEdit, useRevertResponseEdit } from "@/lib/api/hooks/responses";

const USER = "user-1";
const WS = "ws-1";
const RESPONSE = "resp-1";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const spy = jest.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, spy, wrapper };
}

const ok = (data: unknown) =>
  Promise.resolve({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data }) } as Response);

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** Does any invalidate call cover the response's versions key? */
function coversVersions(spy: jest.SpyInstance, client: QueryClient): boolean {
  const key = queryKeys.responses.versions(USER, RESPONSE);
  client.setQueryData(key, []);
  const query = client.getQueryCache().find({ queryKey: key })!;
  return spy.mock.calls.some(([filters]) => {
    const f = (filters ?? {}) as { queryKey?: readonly unknown[]; predicate?: (q: typeof query) => boolean };
    if (f.predicate) return f.predicate(query);
    return Boolean(f.queryKey) && JSON.stringify(key.slice(0, f.queryKey!.length)) === JSON.stringify(f.queryKey);
  });
}

test("saving an edit refreshes the response's versions list", async () => {
  global.fetch = jest.fn(() => ok({ id: "e1", revision: 1, content: "x", createdAt: "", updatedAt: "" })) as unknown as typeof fetch;
  const { client, spy, wrapper } = setup();
  const { result } = renderHook(() => useCreateResponseEdit(USER, WS), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ responseId: RESPONSE, input: { content: "My edit" } });
  });
  expect(coversVersions(spy, client)).toBe(true);
});

test("reverting an edit refreshes it too", async () => {
  global.fetch = jest.fn(() => ok({ reverted: true })) as unknown as typeof fetch;
  const { client, spy, wrapper } = setup();
  const { result } = renderHook(() => useRevertResponseEdit(USER, WS), { wrapper });
  await act(async () => {
    await result.current.mutateAsync(RESPONSE);
  });
  expect(coversVersions(spy, client)).toBe(true);
});

test("saving review fixes (an edit by version) refreshes the versions lists", async () => {
  global.fetch = jest.fn(() => ok({ id: "e2", revision: 2, content: "y", editorId: "u", createdAt: "" })) as unknown as typeof fetch;
  const { client, spy, wrapper } = setup();
  const { result } = renderHook(() => useCreateVersionEdit(USER, WS), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ versionId: "v2", input: { content: "Fixed", baseRevision: 1 } } as never);
  });
  expect(coversVersions(spy, client)).toBe(true);
});
