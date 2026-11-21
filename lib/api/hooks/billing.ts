"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "./query-keys";
import type { CheckoutInput, MySubscription } from "@/lib/schemas/billing";

export type { MySubscription } from "@/lib/schemas/billing";

/** Step 8.5: the caller's subscription (`GET /api/v1/me/subscription`). */
export function useMySubscription(
  userId: string,
  options?: Omit<UseQueryOptions<MySubscription, Error>, "queryKey" | "queryFn">
) {
  return useQuery({
    queryKey: queryKeys.me.subscription(userId),
    enabled: Boolean(userId),
    queryFn: ({ signal }) => api<MySubscription>("/api/v1/me/subscription", { signal }),
    staleTime: 10_000,
    ...options,
  });
}

/** Starts a hosted checkout and sends the browser to it. */
export function useStartCheckout() {
  return useMutation({
    mutationFn: (input: CheckoutInput) =>
      api<{ url: string }>("/api/v1/billing/checkout", { method: "POST", body: input }),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
}

/** Opens the provider's customer portal (payment methods, invoices). */
export function useOpenBillingPortal() {
  return useMutation({
    mutationFn: () => api<{ url: string }>("/api/v1/billing/portal", { method: "POST" }),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
}

function useSubscriptionAction<TInput>(
  userId: string,
  path: string,
  body?: (input: TInput) => Record<string, unknown>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) =>
      api<{ ok: true }>(path, { method: "POST", ...(body ? { body: body(input) } : {}) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me.subscription(userId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.home.get(userId) });
    },
  });
}

export const useCancelSubscription = (userId: string) =>
  useSubscriptionAction<void>(userId, "/api/v1/billing/cancel", () => ({ atPeriodEnd: true }));

export const useResumeSubscription = (userId: string) =>
  useSubscriptionAction<void>(userId, "/api/v1/billing/resume");

export const useChangePlan = (userId: string) =>
  useSubscriptionAction<CheckoutInput>(userId, "/api/v1/billing/change-plan", (input) => ({ ...input }));
