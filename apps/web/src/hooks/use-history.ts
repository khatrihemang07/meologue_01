import type { Entry, EntryStore, TaskStore } from "@meologue/core";
import { mintId } from "@meologue/core";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import {
  INITIAL_ENTRIES_PAGE_PARAM,
  nextEntriesPageParam,
  refreshNewestEntriesPage,
} from "@/lib/entries-pagination";
import { normalizeEntryBody } from "@/lib/entry-text";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { requestSync } from "@/lib/sync-runner";

/**
 * Issue #79's scroll-triggered "load older" glue, handed to Shell (via
 * whichever page renders History) so it can call `fetchMore` once the
 * reader reaches the oldest loaded edge — see use-pinned-scroll.ts's
 * `pagination` option, whose shape this mirrors on purpose so a caller can
 * pass this object straight through with no reshaping.
 */
export interface UseHistoryPagination {
  /** Whether an older page exists to fetch — false once list() has run out of Entries. */
  hasMore: boolean;
  /** Whether a page fetch (the initial one or an older one) is already in flight. */
  fetching: boolean;
  /** Fetches the next older page. A no-op call while `!hasMore || fetching` is safe but pointless — callers should check first. */
  fetchMore: () => void;
}

export interface UseHistoryResult {
  entries: Entry[];
  /** Issue #79 — see UseHistoryPagination's own doc comment. */
  pagination: UseHistoryPagination;
  sendEntry: (raw: string) => void;
  /** Changes an Entry's body locally, then pushes it (ADR 0028) — the Composer's edit-commit path. Refuses an edit to empty/whitespace, same as sendEntry. */
  editEntry: (id: string, body: string) => void;
  /**
   * Removes an Entry locally and pushes the tombstone (ADR 0028). Called
   * once the confirm dialog in front of Delete has already been accepted
   * (issue #82's `ConfirmDialog`, hosted by entry-actions.tsx's
   * `EntryActionsSheet`) — this function itself trusts that choice and
   * deletes unconditionally, the same way `editEntry` above trusts a
   * commit it's handed.
   *
   * Takes the whole Entry, not just its id — a holdover from when the
   * pre-delete body fed Undo's restore path (see this file's git history,
   * and the note on why that path is gone below), kept now because the
   * caller already has the live Entry in hand at the moment Delete is
   * chosen, and matching `editEntry`'s "id, body" shape here would gain
   * nothing but a mismatched signature.
   *
   * Issue #82 replaced this design entirely rather than adding to it. The
   * comment this one replaces recorded the OPPOSITE decision — that
   * Delete deliberately had no confirmation, because it already sat behind
   * a long-press (or right-click) into a menu and a second, deliberate
   * Delete choice, "so confirming first would be a third gate on top of
   * two already-deliberate ones," with a cheap Undo covering the same
   * worry instead. Both premises are gone: issue #78 removed the
   * long-press/menu gate entirely (Delete is now a single visible button
   * on hover, or one tap in a sheet — one gate, not two), and issue #82's
   * confirmation *replaces* Undo rather than joining it, so "confirm on
   * top of Undo" was never the tradeoff actually being made here. With
   * only one gate left before a delete used to fire immediately, asking
   * first is the cheaper mistake to guard against — a confirm a reader
   * can back out of, instead of a mistake they have to notice and undo
   * within a fixed window.
   */
  removeEntry: (entry: Entry) => void;
}

/**
 * Owns this Device's History: a TanStack Query infinite query for
 * `store.list()` (issue #79 — 50 Entries at a time, widening as the reader
 * scrolls back) and mutations for Sending, editing and removing an Entry
 * (ADR 0013, extended by ADR 0028 for the latter two). Every mutation has
 * the same shape — `mutationFn` calls the store, `onSuccess` is
 * `afterLocalWrite` below, which is where the refresh-then-nudge-Sync
 * reasoning lives.
 *
 * An Entry renders from the local write immediately; nothing here waits on
 * the network.
 */
export function useHistory(
  store: EntryStore,
  taskStore: TaskStore,
  deviceId: string,
): UseHistoryResult {
  const entriesQuery = useInfiniteQuery({
    queryKey: ENTRIES_QUERY_KEY,
    // The first page ever fetched asks for the newest ENTRIES_PAGE_SIZE
    // Entries, not the whole History — that's the acceptance criterion a
    // fresh open only reads 50 of ("A fresh open reads 50 Entries, not all
    // of them"), not merely a client-side slice of everything list()
    // already returned.
    queryFn: ({ pageParam }) => store.list(pageParam),
    initialPageParam: INITIAL_ENTRIES_PAGE_PARAM,
    getNextPageParam: (lastPage) => nextEntriesPageParam(lastPage),
    // Off for this query alone, against the client-wide default (issue
    // #79). TanStack Query refetches an infinite query by walking every
    // page it holds, one queryFn call each, through the SQLite worker — so
    // a reader who has scrolled back through a year of History pays that
    // whole walk on every return to the window. A `staleTime` only narrows
    // the window in which it is skipped; any absence longer than that (so,
    // in practice, most of them) still pays in full.
    //
    // Nothing is lost by turning it off, because focus is already wired to
    // the cheaper path: wake-signals.web.ts subscribes to both `focus` and
    // `visibilitychange` and wakes the sync loop, and sync finishes by
    // calling refreshNewestEntriesPage — a bounded refresh of page 0,
    // which is where a newly Synced Entry lands. The catch-up the user
    // sees is the same; what goes away is re-reading pages that a Sync
    // could not have changed without also changing page 0.
    refetchOnWindowFocus: false,
  });

  // Consumers (composer-page.tsx, use-history-search.ts, reflection-page.tsx)
  // all predate paging and expect a flat, newest-first Entry[] — the exact
  // shape store.list() itself has always returned. Flattening here, once,
  // keeps that boundary intact so none of them have to learn TanStack
  // Query's `{ pages, pageParams }` shape just because this hook's own
  // fetch strategy changed underneath it. Pages arrive oldest-page-last and
  // each page is already newest-first internally (list()'s own order), so
  // a plain concatenation is already newest-first end to end — no re-sort
  // needed.
  const entries = entriesQuery.data?.pages.flat() ?? [];

  // Every local write ends the same two ways (ADR 0013, ticket 38): make the
  // new state visible, then nudge Sync so the change leaves this Device now
  // rather than at the next scheduled tick. `requestSync` coalesces that
  // against any sync already in flight, so calling it per write never races
  // a second sync() against the store.
  //
  // Shared rather than repeated once per mutation because the failure mode of
  // getting it wrong is invisible: a mutation that refreshes but forgets
  // requestSync looks completely correct on screen and simply takes up to
  // SYNC_INTERVAL_MS longer to reach the other Devices.
  //
  // refreshNewestEntriesPage, not invalidateQueries(ENTRIES_QUERY_KEY): a
  // Send/edit/delete can only ever change the newest page's content (a Send
  // always lands at the newest end; an edit or delete of something further
  // back is the rare case this trades away deliberately — see that
  // function's own doc comment, which sync-runner.ts's post-sync refresh
  // shares this same reasoning with).
  const afterLocalWrite = async () => {
    await refreshNewestEntriesPage(store);
    void requestSync(store, taskStore, deviceId);
  };

  const sendEntryMutation = useMutation({
    mutationFn: (entry: Entry) => store.upsert([entry]),
    onSuccess: afterLocalWrite,
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
      deletedAt: null,
    });
  }

  const editEntryMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => store.edit(id, body),
    onSuccess: afterLocalWrite,
  });

  function editEntry(id: string, raw: string) {
    const body = normalizeEntryBody(raw);
    if (body === null) {
      return;
    }
    editEntryMutation.mutate({ id, body });
  }

  const removeEntryMutation = useMutation({
    mutationFn: (id: string) => store.remove(id),
    onSuccess: afterLocalWrite,
  });

  // Why there is no restore path any more, for whoever next reaches for
  // `store.upsert()` to bring an Entry back the way the old Undo used to:
  // it cannot reuse the deleted id. The Server's own guard —
  // `on conflict (id) do update ... where entries.deleted_at is null`
  // (server/src/sync.rs) — makes a delete terminal for that id,
  // permanently and deliberately; it is what lets offline conflicts
  // converge with no reconciliation machinery at all. A push that tried to
  // revive the same id would be silently rejected forever, never assigned
  // a `seq`, and sit in `pending()` re-pushing every SYNC_INTERVAL_MS while
  // every other Device went on showing it deleted — a silent, permanent
  // divergence. A real restore would need to mint a fresh id instead
  // (`nothing -> A'` in the change-log model, which the Server accepts
  // unconditionally) — which is exactly what Undo's `restoreEntryMutation`
  // used to do, before issue #82 removed it along with the toast that
  // triggered it. Confirming before the delete happens is cheaper to get
  // right than resurrecting one after the fact, so that's where issue #82
  // put the safeguard instead.
  function removeEntry(entry: Entry) {
    removeEntryMutation.mutate(entry.id);
  }

  return {
    entries,
    pagination: {
      hasMore: entriesQuery.hasNextPage,
      fetching: entriesQuery.isFetchingNextPage,
      fetchMore: () => void entriesQuery.fetchNextPage(),
    },
    sendEntry,
    editEntry,
    removeEntry,
  };
}
