"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ALL_FEATURES_ON, type FeatureStates } from "@/lib/features/flags";

export const FEATURES_QUERY_KEY = ["features"] as const;

/**
 * Step 10.6: which features are on right now (`GET /api/v1/features`).
 * Rechecked every minute and when the tab regains focus; everything counts as
 * on until the first answer (the server refuses a paused feature anyway).
 */
export function useFeatureFlags(): FeatureStates {
  const { data } = useQuery({
    queryKey: FEATURES_QUERY_KEY,
    queryFn: ({ signal }) => api<FeatureStates>("/api/v1/features", { signal }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return { ...ALL_FEATURES_ON, ...(data ?? {}) };
}
