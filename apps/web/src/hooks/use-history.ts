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
 * Owns this Device's History: a TanStack Query query for `store.list()` and
 * mutations for Sending, editing and removing an Entry (ADR 0013, extended
 * by ADR 0028 for the latter two). Every mutation has the same shape —
 * `mutationFn` calls the store, `onSuccess` is `afterLocalWrite` below,
 * which is where the invalidate-then-nudge-Sync reasoning lives.
 *
 * An Entry renders from the local write immediately; nothing here waits on
 * the network.
 */
export function useHistory(store: EntryStore, deviceId: string): UseHistoryResult {
  const entriesQuery = useQuery({
    queryKey: ENTRIES_QUERY_KEY,
    queryFn: () => store.list(),
  });

  // Every local write ends the same two ways (ADR 0013, ticket 38): make the
  // new state visible, then nudge Sync so the change leaves this Device now
  // rather than at the next scheduled tick. `requestSync` coalesces that
  // against any sync already in flight, so calling it per write never races
  // a second sync() against the store.
  //
  // Shared rather than repeated once per mutation because the failure mode of
  // getting it wrong is invisible: a mutation that invalidates but forgets
  // requestSync looks completely correct on screen and simply takes up to
  // SYNC_INTERVAL_MS longer to reach the other Devices.
  const afterLocalWrite = async () => {
    await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
    void requestSync(store, deviceId);
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
    entries: entriesQuery.data ?? [],
    sendEntry,
    editEntry,
    removeEntry,
  };
}
