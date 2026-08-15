import type { Entry, EntryStore } from "@meologue/core";
import { mintId } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { normalizeEntryBody } from "@/lib/entry-text";
import { queryClient } from "@/lib/query-client";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { requestSync } from "@/lib/sync-runner";

export interface UseHistoryResult {
  entries: Entry[];
  sendEntry: (raw: string) => void;
}

/**
 * Owns this Device's History: a TanStack Query query for `store.list()` and
 * a mutation for Sending an Entry (ADR 0013). An Entry renders from the
 * local write immediately — the mutation's `onSuccess` awaits the entries
 * query's invalidation before nudging the sync loop (`requestSync`,
 * `lib/sync-runner.ts`, ticket 38) to run right away rather than waiting
 * for its next scheduled tick. `requestSync` coalesces this against any
 * sync already in flight (the periodic tick, a wake signal) rather than
 * racing a second `sync()` call against the store.
 */
export function useHistory(store: EntryStore, deviceId: string): UseHistoryResult {
  const entriesQuery = useQuery({
    queryKey: ENTRIES_QUERY_KEY,
    queryFn: () => store.list(),
  });

  const sendEntryMutation = useMutation({
    mutationFn: (entry: Entry) => store.upsert([entry]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
      void requestSync(store, deviceId);
    },
  });

  function sendEntry(raw: string) {
    const body = normalizeEntryBody(raw);
    if (body === null) {
      return;
    }
    sendEntryMutation.mutate({
      id: mintId(),
      deviceId,
      body,
      createdAt: new Date().toISOString(),
      seq: null,
      syncedAt: null,
    });
  }

  return { entries: entriesQuery.data ?? [], sendEntry };
}
