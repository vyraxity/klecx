"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "./query-keys";
import type {
  CreditHistoryEntry,
  CreditHistoryType,
  UsageByMemberRow,
  UsageSummary,
  UsageTimeseriesPoint,
} from "@/lib/usage/types";

/** Step 9.3: Settings → Usage data. Every key starts with the user id. */
export function useUsageSummary(userId: string, period: "current" | "prev") {
  return useQuery<UsageSummary>({
    queryKey: queryKeys.me.usageSummary(userId, period),
    queryFn: ({ signal }) => api<UsageSummary>(`/api/v1/me/usage/summary?period=${period}`, { signal }),
    placeholderData: keepPreviousData,
  });
}

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function useUsageTimeseries(userId: string, days: number) {
  return useQuery<UsageTimeseriesPoint[]>({
    queryKey: queryKeys.me.usageTimeseries(userId, days),
    queryFn: ({ signal }) => {
      const to = new Date();
      const from = new Date(to.getTime() - (days - 1) * 86_400_000);
      return api<{ points: UsageTimeseriesPoint[] }>(
        `/api/v1/me/usage/timeseries?from=${isoDay(from)}&to=${isoDay(to)}`,
        { signal }
      ).then((d) => d.points);
    },
    placeholderData: keepPreviousData,
  });
}

export function useUsageByMember(userId: string, period: "current" | "prev") {
  return useQuery<UsageByMemberRow[]>({
    queryKey: queryKeys.me.usageByMember(userId, period),
    queryFn: ({ signal }) =>
      api<{ members: UsageByMemberRow[] }>(`/api/v1/me/usage/by-member?period=${period}`, { signal }).then(
        (d) => d.members
      ),
    placeholderData: keepPreviousData,
  });
}

export function useCreditHistory(userId: string, type: CreditHistoryType) {
  return useInfiniteQuery({
    queryKey: queryKeys.me.creditHistory(userId, type),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<{ entries: CreditHistoryEntry[]; nextCursor: string | null }>(
        `/api/v1/me/credits/history?type=${type}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { signal }
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}
