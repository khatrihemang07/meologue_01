import type { WireConfigPatch } from "@meologue/core";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConfigResult } from "@/lib/config-transport";
import { getConfig, patchConfig } from "@/lib/config-transport";
import { CONFIG_QUERY_KEY } from "@/lib/query-keys";
import { refreshCapabilities, useServerReachable, useSettingsStore } from "@/lib/settings";

/**
 * `GET`/`PATCH /v1/config`, owned by the AI and Sync sections' own "On the
 * server" sub-groups (issue #203) — the Server-backed counterpart to every
 * Device setting `useSettingsStore` already owns.
 *
 * `query` is gated on `serverUrl !== "" && serverReachable`, matching
 * `digest-page.tsx`'s own `enabled: serverReachable` (that page's own
 * comment: "not fetched at all while the Server is down") plus the
 * `serverUrl !== ""` half ADR 0011 already requires before any Server
 * request is meaningful — there is nothing to configure when Sync itself
 * is off, and no point retrying a Server `server-request.ts`'s own
 * `serverReachable` flag already knows just failed.
 *
 * `save` is the one mutation both sections' Save buttons call. On success
 * it invalidates `CONFIG_QUERY_KEY` (so every mounted reader of this same
 * query — AI and Sync both hold one — refetches the write it just made,
 * with no second round trip of its own) **and** calls `refreshCapabilities`
 * (issue #133's own cache) — the acceptance criterion's own wording: "after
 * a successful write the page refreshes capabilities, so a toggled-off
 * feature locks its chat-list row immediately rather than waiting for a
 * background refresh." Both only run when the write actually succeeded
 * (`result.ok`) — `patchConfig` never throws (mirrors `modelsTransport`'s
 * own discipline), so a failed write still reaches `onSuccess` and has to
 * check the result's own `ok` before treating it as one.
 */
export interface UseServerConfigResult {
  query: UseQueryResult<ConfigResult>;
  save: (patch: WireConfigPatch) => Promise<ConfigResult>;
}

export function useServerConfig(): UseServerConfigResult {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const serverReachable = useServerReachable();
  // The contextual client (`QueryClientProvider`'s own, via React context),
  // not the app-wide singleton `query-client.ts` exports for module-scope
  // code with no component tree to read context from — this hook runs
  // inside components that always have one, and invalidating against a
  // hardcoded import rather than whichever client this tree actually reads
  // from is exactly the kind of thing that works in production (where
  // there is only ever one client) and silently does nothing under a test
  // that renders against its own, separate `QueryClientProvider`.
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: getConfig,
    enabled: serverUrl !== "" && serverReachable,
  });

  const mutation = useMutation({
    mutationFn: patchConfig,
    onSuccess: async (result) => {
      if (!result.ok) {
        return;
      }
      await queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY });
      await refreshCapabilities();
    },
  });

  return { query, save: mutation.mutateAsync };
}
