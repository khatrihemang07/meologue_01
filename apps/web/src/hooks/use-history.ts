import type { Entry, EntryStore } from "@meologue/core";
import { mintId } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeEntryBody } from "@/lib/entry-text";
import { queryClient } from "@/lib/query-client";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { requestSync } from "@/lib/sync-runner";

/** How long the delete toast's Undo stays available. See removeEntry below. */
const UNDO_WINDOW_MS = 10_000;

export interface UseHistoryResult {
  entries: Entry[];
  sendEntry: (raw: string) => void;
  /** Changes an Entry's body locally, then pushes it (ADR 0028) — the Composer's edit-commit path. Refuses an edit to empty/whitespace, same as sendEntry. */
  editEntry: (id: string, body: string) => void;
  /**
   * Removes an Entry locally, pushes the tombstone, and offers Undo via a
   * toast (ADR 0028). Takes the whole Entry, not just its id, because
   * store.remove() blanks the body — undo needs it captured beforehand, and
   * the caller (EntryRow, by way of History) already has the live Entry in
   * hand at the moment Delete is chosen, so capturing it is just "pass the
   * object through," not a separate step.
   *
   * Deliberately a different shape from Session delete (sessions-page.tsx,
   * issue #63), which is a two-step inline confirm with no undo. That's not
   * an oversight: a Session's delete is a single visible tap that hits the
   * Server immediately — irreversible the moment it fires, so the app asks
   * first. An Entry's delete already sits behind a long-press (or
   * right-click) into a menu and a second, deliberate Delete choice, and
   * nothing leaves this Device until the next sync tick — so confirming
   * first would be a third gate on top of two already-deliberate ones, and
   * a cheap Undo covers the same "did I mean that" worry without it. Both
   * designs land in the same place: equally hard to trigger by accident.
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

  // Undo's other half, and the reason it re-creates rather than resurrects.
  //
  // `store.edit()` can't serve here: ADR 0028 gives it a `WHERE deleted_at
  // IS NULL` guard so a stale edit can never bring back an Entry deleted
  // elsewhere, and that guard rejects Undo's own attempt just as happily.
  //
  // Neither can `upsert()` under the *same id*, and that one is the trap.
  // The guard that decides this is the Server's, not this store's:
  // `on conflict (id) do update ... where entries.deleted_at is null`
  // (server/src/sync.rs) makes a delete terminal for that id, permanently
  // and deliberately — it is what lets offline conflicts converge with no
  // reconciliation machinery at all. Reusing the id would leave the local
  // row looking restored while every push of it was silently rejected; and
  // because a rejected push is never assigned a `seq`, the Entry would sit
  // in `pending()` forever, re-pushed every SYNC_INTERVAL_MS and refused
  // every time, while every other Device went on showing it deleted. A
  // silent, permanent divergence — precisely what ADR 0028 exists to make
  // impossible.
  //
  // So Undo mints a new id. In the change-log model that is `nothing -> A'`,
  // which the Server accepts unconditionally: no race against whether the
  // tombstone has already pushed, and no Server change needed. `createdAt`
  // carries over deliberately — it is what `list()` orders by, so the
  // restored Entry lands back exactly where it was instead of jumping to
  // the top of History. The original id's delete still stands and still
  // travels, which is honest: the user did delete that Entry.
  const restoreEntryMutation = useMutation({
    mutationFn: (entry: Entry) =>
      store.upsert([{ ...entry, id: mintId(), seq: null, syncedAt: null, deletedAt: null }]),
    onSuccess: afterLocalWrite,
  });

  function removeEntry(entry: Entry) {
    removeEntryMutation.mutate(entry.id);
    toast("Entry deleted", {
      // Explicit, and longer than sonner's 4s default: this is an undo
      // window, not a status message. Four seconds is enough time to read
      // a notice but not to notice a mistake, reconsider, and act — and
      // once it closes the only way back is retyping the Entry.
      duration: UNDO_WINDOW_MS,
      action: {
        label: "Undo",
        onClick: () => restoreEntryMutation.mutate(entry),
      },
    });
  }

  return {
    entries: entriesQuery.data ?? [],
    sendEntry,
    editEntry,
    removeEntry,
  };
}
