"use client";

import * as React from "react";
import {
  QueryClient,
  QueryClientContext,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "./query-keys";
import type { UpdatePreferencesInput } from "@/lib/schemas/user-preferences";
import type { Density, Theme } from "@/lib/theme";

/** Step 9.2: the full object `GET /api/v1/me/preferences` returns (defaults applied). */
export interface UserPreferencesDto {
  uiLocale: string | null;
  aiLanguage: string | null;
  webSearchEnabled: boolean;
  theme: Theme;
  themeSaved: boolean;
  enterToSend: boolean;
  reduceMotion: boolean | null;
  voiceProvider: string | null;
  voiceId: string | null;
  voiceSpeed: number;
  onboardingDismissed: boolean;
  density: Density;
  /** Pre-10.6 fix: the default model for new messages; null = Automatic. */
  defaultModelKey?: "text-economy" | "text-standard" | null;
}

export interface UserCreditsDto {
  tokens: number;
}

// Components rendered outside a QueryClientProvider (some tests) get an idle
// query instead of a crash, like `useEntitlements`.
let idleQueryClient: QueryClient | null = null;
export function getIdleQueryClient(): QueryClient {
  idleQueryClient ??= new QueryClient();
  return idleQueryClient;
}

export function useUserPreferences(
  userId: string,
  options?: Omit<
    UseQueryOptions<UserPreferencesDto, Error>,
    "queryKey" | "queryFn"
  >,
) {
  const contextClient = React.useContext(QueryClientContext);
  return useQuery(
    {
      // No user yet: a key that is never fetched (userQueryKey needs an id).
      queryKey: userId
        ? queryKeys.me.preferences(userId)
        : (["me", "preferences", "no-user"] as const),
      queryFn: ({ signal }) =>
        api<UserPreferencesDto>("/api/v1/me/preferences", { signal }),
      ...options,
      enabled:
        Boolean(userId) && Boolean(contextClient) && (options?.enabled ?? true),
    },
    contextClient ?? getIdleQueryClient()
  );
}

export function useUpdateUserPreferences(userId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdatePreferencesInput) =>
      api<UserPreferencesDto>("/api/v1/me/preferences", {
        method: "PATCH",
        body: input,
      }),
    onMutate: async (input) => {
      const key = queryKeys.me.preferences(userId);
      await queryClient.cancelQueries({ queryKey: key });

      const previous = queryClient.getQueryData<UserPreferencesDto>(key);
      if (previous) {
        // Optimistic: every field the request sets (undefined = unchanged).
        const changes = Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined)
        ) as Partial<UserPreferencesDto>;
        queryClient.setQueryData<UserPreferencesDto>(key, {
          ...previous,
          ...changes,
          ...(input.theme !== undefined ? { themeSaved: true } : {}),
        });
      }

      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.me.preferences(userId),
          context.previous,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.me.preferences(userId),
      });
    },
  });
}

export function useCredits(
  userId: string,
  options?: Omit<UseQueryOptions<UserCreditsDto, Error>, "queryKey" | "queryFn">,
) {
  return useQuery({
    queryKey: queryKeys.me.credits(userId),
    enabled: Boolean(userId),
    queryFn: ({ signal }) =>
      api<UserCreditsDto>("/api/user/tokens", { signal }),
    ...options,
  });
}
