import { SYNC_INTERVAL_MS } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { SYNC_QUERY_KEY } from "@/lib/query-keys";
import { requestSync } from "@/lib/sync-runner";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";
import { isTabVisible, subscribeToWakeEvents } from "@/platform/wake-signals";

/**
 * Mounted once in `main.tsx`, above the router — not inside
 * `EntryStoreLayout`, which wraps `/`, `/reflect` and `/digest` (issue #75
 * deleted `/history`) and unmounts while the user is on Settings (ADR
 * 0008/0009). Ticket 38 deletes
 * `@meologue/core`'s hand-rolled `startContinuousSync` scheduler in favor of
 * TanStack Query's own interval refetching for cadence; `requestSync`
 * (`lib/sync-runner.ts`) still owns coalescing overlapping triggers — an
 * interval tick, a wake signal, a Send — into at most one sync at a time.
 *
 * Subscribes to the exact same `entryStoreQueryOptions` as
 * `EntryStoreLayout` so the cache still opens the store at most once per
 * page load, whichever of the two mounts first, and the sync query below
 * stays disabled (inert) until that resolves.
 */
export function SyncLoop() {
  const storeQuery = useQuery(entryStoreQueryOptions);

  const opened = storeQuery.data;

  useQuery({
    queryKey: SYNC_QUERY_KEY,
    queryFn: async () => {
      // Live, not pushed: TanStack's own background/focus detection is
      // DOM-based (`document.visibilityState`), and Android's WebView
      // doesn't reliably flip that when backgrounded — the whole reason the
      // wake-signals platform seam exists.
      if (opened && isTabVisible()) {
        await requestSync(
          {
            store: opened.store,
            taskStore: opened.taskStore,
            projectStore: opened.projectStore,
            labelStore: opened.labelStore,
            commentStore: opened.commentStore,
          },
          opened.deviceId,
        );
      }
      return null;
    },
    enabled: opened !== undefined,
    refetchInterval: SYNC_INTERVAL_MS,
    // Bypasses TanStack's own background suppression in favor of the live
    // isTabVisible() check above.
    refetchIntervalInBackground: true,
    // Wake-worthy focus/reconnect signals are wired in explicitly below,
    // through the platform-specific wake-signals seam, rather than through
    // TanStack's own DOM-based defaults.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  useEffect(() => {
    if (!opened) {
      return;
    }
    return subscribeToWakeEvents(() => {
      // wake-signals.web.ts's "online" and "focus" listeners can fire while
      // the tab is genuinely hidden (e.g. a backgrounded tab regaining
      // network) — this check is what makes "stops polling while hidden"
      // hold for wake signals too, not just the periodic tick above.
      if (!isTabVisible()) {
        return;
      }
      void requestSync(
        {
          store: opened.store,
          taskStore: opened.taskStore,
          projectStore: opened.projectStore,
          labelStore: opened.labelStore,
          commentStore: opened.commentStore,
        },
        opened.deviceId,
      );
    });
  }, [opened]);

  return null;
}
