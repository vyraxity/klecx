"use client";

import * as React from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ALL_FEATURES_ON, type FeatureStates } from "@/lib/features/flags";

export const FEATURES_QUERY_KEY = ["features"] as const;

let detachedClient: QueryClient | null = null;
/** For a component rendered without a QueryClientProvider: nothing is fetched, everything is on. */
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return detachedClient;
}

/**
 * Step 10.6: which features are on right now (`GET /api/v1/features`).
 *
 * Only the app shell's banner fetches (`{ fetch: true }`: every minute and when
 * the tab regains focus); every other control reads the same cache, so it
 * doesn't add requests. Everything counts as on until the first answer (the
 * server refuses a paused feature anyway).
 */
export function useFeatureFlags(options: { fetch?: boolean } = {}): FeatureStates {
  const contextClient = React.useContext(QueryClientContext);
  const shouldFetch = Boolean(options.fetch && contextClient);
  const { data } = useQuery(
    {
      queryKey: FEATURES_QUERY_KEY,
      queryFn: ({ signal }) => api<FeatureStates>("/api/v1/features", { signal }),
      enabled: shouldFetch,
      staleTime: 60_000,
      refetchInterval: shouldFetch ? 60_000 : false,
      refetchOnWindowFocus: shouldFetch,
      retry: false,
    },
    contextClient ?? getDetachedClient()
  );
  return { ...ALL_FEATURES_ON, ...(data ?? {}) };
}
