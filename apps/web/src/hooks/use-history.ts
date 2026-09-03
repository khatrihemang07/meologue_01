import type {
  CommentStore,
  Entry,
  EntryStore,
  LabelStore,
  ProjectStore,
  Task,
  TaskStore,
} from "@meologue/core";
import { mintId, orderKeyBetween } from "@meologue/core";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { quickAddOptionsNow } from "@/lib/composer-editor";
import {
  INITIAL_ENTRIES_PAGE_PARAM,
  nextEntriesPageParam,
  refreshNewestEntriesPage,
} from "@/lib/entries-pagination";
import { deviceUtcOffsetMinutes, entryDayKey } from "@/lib/entry-day";
import { normalizeEntryBody } from "@/lib/entry-text";
import {
  type ComposerPromotionContext,
  type PromotedTask,
  promoteBareCheckboxes,
} from "@/lib/promote-tasks";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { requestSync } from "@/lib/sync-runner";
import { refreshTasks } from "@/lib/tasks-refresh";

/**
 * A caller with no live Composer to ask (this hook's own tests among
 * them) gets `promoteBareCheckboxes` the identical fresh "now" and
 * "nothing demoted" the plugin itself would compute if it had been asked
 * right now — see `ComposerPromotionContext`'s own doc comment
 * (promote-tasks.ts) for why the Composer's own value, when there is one,
 * always wins over this fallback instead of the two racing.
 */
function defaultPromotionContext(): ComposerPromotionContext {
  return { quickAddOptions: quickAddOptionsNow(), active: null };
}

/**
 * Turns one `PromotedTask` (promote-tasks.ts) into a real `Task` row —
 * `use-tasks.ts`'s own `addTask` builds an identically-shaped literal
 * for the same reason (`Task`'s required fields, task-types.ts's own
 * comment on why): a Task minted here starts with the same "nothing"
 * every field defaults to for a caller with no opinion of its own,
 * except `date`, which carries the Entry's own capture date rather than
 * staying undated (ADR 0048: "A Task promoted from an Entry takes the
 * Entry's capture date; one created in Todo stays undated" — #169's
 * view-context inheritance, with the Entry as the origin).
 *
 * **The capture-date rule, precisely.** `promoted.date` is `null` only
 * when nothing in the checkbox line parsed to a date — in that case,
 * and ONLY that case, the Entry's own capture date wins, day-only
 * (mirroring `todo-page.tsx`'s own `captureDate`: a Date "may carry a
 * time," but nothing about *when in the day* an Entry happened to be
 * captured is a plan the reader made for the Task). When a date DID
 * parse (`- [ ] buy milk tomorrow`), that parsed date is what "the
 * Composer highlights recognised tokens... so it files itself" (issue
 * #173's own acceptance criterion) actually means, and it wins instead
 * — this is `??`, not an unconditional overwrite, on purpose.
 * `deadline`/`priority`/`dateString`/`labelIds` all carry the
 * parse's own resolved values unconditionally, the identical fields
 * `todo-page.tsx`'s own `handleAdd` already writes from
 * `taskFieldsFromQuickAdd` for the add field — Promotion is that same
 * parse, not a second, poorer one.
 *
 * Module-scope and exported, not a closure inside `useHistory` (issue
 * #174) — `backfill-tasks.ts` needs the identical capture-date rule for
 * every checkbox it promotes out of existing History, and duplicating
 * this function there would be a second place that rule could drift from
 * this one. `deviceId` is threaded in as a plain parameter for exactly
 * that reuse: the backfill has its own `deviceId`, read once from
 * `EntryStore.ensureDeviceId()`, not this hook's own closed-over value.
 */
export function promotedTaskToTask(
  promoted: PromotedTask,
  deviceId: string,
  capturedAt: string,
  orderKey: string,
  labelIds: string[],
): Task {
  return {
    id: promoted.id,
    deviceId,
    content: promoted.content,
    completedAt: promoted.checked ? capturedAt : null,
    orderKey,
    // Same starting value as orderKey (issue #182) — see use-tasks.ts's
    // addTask own identical bootstrap for why.
    dayOrder: orderKey,
    createdAt: capturedAt,
    seq: null,
    syncedAt: null,
    deletedAt: null,
    date: promoted.date ?? entryDayKey(capturedAt, deviceUtcOffsetMinutes()),
    deadline: promoted.deadline,
    priority: promoted.priority,
    labelIds,
    dateString: promoted.dateString,
    projectId: null,
    sectionId: null,
    parentId: null,
    // No Description — a Task promoted out of a checkbox line starts
    // with the same "nothing chosen yet" state one created directly in
    // Todo does (issue #180, @meologue/core's task-types.ts).
    description: null,
  };
}

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
  /**
   * `promotion`, when given, is exactly what `composer.tsx`'s own `send()`
   * built from the live editor — see `ComposerPromotionContext`'s own doc
   * comment (promote-tasks.ts) for why that has to be threaded through
   * rather than recomputed here, and why every caller without one (a
   * test, Reflection's own Grounding writer, anything else that isn't the
   * live Composer) is still correct without it.
   */
  sendEntry: (raw: string, promotion?: ComposerPromotionContext) => void;
  /**
   * Changes an Entry's body locally, then pushes it (ADR 0028). Refuses an
   * edit to empty/whitespace, same as sendEntry. Non-promoting (issue
   * #173) — this is also the tick path's own door (composer-page.tsx's
   * `handleToggleTask`), and a checkbox tap must keep working exactly as
   * it does today, not silently mint a Task mid-tick. `commitEntryEdit`
   * below is the Composer's own edit-commit path instead.
   */
  editEntry: (id: string, body: string) => void;
  /**
   * The Composer's own edit-commit path (issue #173, ADR 0048) —
   * `editEntry`'s promoting sibling, for a genuine edit rather than a
   * checkbox tap: a bare `- [ ]` added to an Entry on a later edit mints a
   * Task exactly as one already present at Send does (CONTEXT.md's Task
   * entry draws no line between the two). The promoted Task's own capture
   * date is the edited Entry's own, unchanged `createdAt` — editing an
   * Entry never moves it in History, and Promotion doesn't either.
   * `promotion` — see `sendEntry`'s own doc comment just above.
   */
  commitEntryEdit: (id: string, body: string, promotion?: ComposerPromotionContext) => void;
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
  // Issue #182: needed only to pass through to requestSync's own
  // SyncStores bag below (sync-runner.ts's own doc comment on why every
  // stream is required there) — this hook does no read or write of its
  // own against any of the three.
  projectStore: ProjectStore,
  labelStore: LabelStore,
  commentStore: CommentStore,
  deviceId: string,
  /**
   * `use-labels.ts`'s own `resolveLabelIds` (issue #170) — Promotion's
   * `#Shopping` needs the identical `%label`-name-to-id round trip
   * `todo-page.tsx`'s own `handleAdd` already awaits for the add field,
   * and this hook has no LabelStore of its own to do that resolution with
   * directly. Defaulted to "no labels resolve to anything" rather than
   * made mandatory, so every existing call site (this file's own tests
   * among them) that never sends a checkbox line with a `#label` on it
   * keeps compiling unchanged — `entry-store-layout.tsx` is the one
   * production caller, and it always passes the real thing (`useLabels`'s
   * own `resolveLabelIds`).
   */
  resolveLabelIds: (names: string[]) => Promise<string[]> = async () => [],
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
    void requestSync({ store, taskStore, projectStore, labelStore, commentStore }, deviceId);
  };

  /**
   * Mints a real `Task` row per `PromotedTask` and writes them, chained
   * end-to-end off one read of the active list — shared by `sendEntry` and
   * `commitEntryEdit` below, the two doors through which a bare checkbox
   * can turn into a Task (ADR 0048: "sending an Entry containing a bare
   * `- [ ]`" reaches both a brand-new Entry and a genuine edit-commit that
   * added one; CONTEXT.md's Task entry states this unconditionally —
   * "every checkbox written in an Entry is a Task" — not scoped to a new
   * Send alone). `orderKeyBetween` is walked forward once per promoted
   * Task rather than recomputed against `active` each time, so two
   * checkboxes written in one Entry land in the order they were written,
   * not both racing for the same "after the last existing Task" slot.
   * `resolveLabelIds` is awaited once per Task, in order, matching
   * `use-labels.ts`'s own `resolveLabelIds` doc comment on why a second
   * `#Shopping` in the same Entry must see the Label the first one just
   * minted rather than racing it.
   */
  async function upsertPromotedTasks(
    promoted: readonly PromotedTask[],
    capturedAt: string,
  ): Promise<void> {
    if (promoted.length === 0) {
      return;
    }
    const active = await taskStore.list();
    let lastKey = active.at(-1)?.orderKey ?? null;
    const tasks: Task[] = [];
    for (const task of promoted) {
      lastKey = orderKeyBetween(lastKey, null);
      const labelIds = await resolveLabelIds(task.labelNames);
      tasks.push(promotedTaskToTask(task, deviceId, capturedAt, lastKey, labelIds));
    }
    await taskStore.upsert(tasks);
  }

  // Promotion's own Tasks (issue #173) land in the same local write each
  // mutation below already made visible — `refreshTasks` (tasks-refresh.ts)
  // is what makes a freshly-promoted Task appear in Todo/Inbox without a
  // reader having to navigate there and back. Shared between `sendEntry`
  // and `commitEntryEdit`'s own `onSuccess` for the identical reason
  // `afterLocalWrite` itself is shared, and skipped when nothing was
  // promoted: an ordinary Send or edit (no checkbox at all) has no Task
  // list to invalidate.
  async function afterPromotion(promotedCount: number): Promise<void> {
    if (promotedCount > 0) {
      await refreshTasks();
    }
  }

  const sendEntryMutation = useMutation({
    mutationFn: async ({
      entry,
      promoted,
    }: {
      entry: Entry;
      promoted: readonly PromotedTask[];
    }) => {
      await upsertPromotedTasks(promoted, entry.createdAt);
      await store.upsert([entry]);
    },
    onSuccess: async (_data, { promoted }) => {
      await afterLocalWrite();
      await afterPromotion(promoted.length);
    },
  });

  function sendEntry(raw: string, promotion?: ComposerPromotionContext) {
    const normalized = normalizeEntryBody(raw);
    if (normalized === null) {
      return;
    }
    // Promotion (issue #173, ADR 0048) fires only on a bare checkbox with
    // no Reference — `promoteBareCheckboxes`'s own loop guard, so a Task
    // created in Todo (which writes no Entry at all) can never feed back
    // into this path, and a line this function has already promoted on an
    // earlier Send is never re-promoted on a later one. `promotion ??
    // defaultPromotionContext()` — see that function's own doc comment.
    const { quickAddOptions, active } = promotion ?? defaultPromotionContext();
    const { body, tasks: promoted } = promoteBareCheckboxes(
      normalized,
      mintId,
      quickAddOptions,
      active,
    );
    sendEntryMutation.mutate({
      entry: {
        id: mintId(),
        deviceId,
        body,
        createdAt: new Date().toISOString(),
        seq: null,
        syncedAt: null,
        deletedAt: null,
      },
      promoted,
    });
  }

  // `editEntry` stays non-promoting, on purpose: it is also the tick
  // path's own door (composer-page.tsx's `handleToggleTask` splices a
  // marker with `toggleTaskAt` and commits through this exact function),
  // and `entry-prose.tsx`'s own comment on `ToggleTaskHandler` is explicit
  // that a bare checkbox "keeps working exactly as it does today" —
  // running Promotion here would mean a tap on a checkbox silently mints a
  // Task mid-tick, an edit nobody asked for. `commitEntryEdit` just below
  // is the promoting door instead, reserved for a genuine Composer
  // edit-commit (composer-page.tsx's `handleCommitEdit`).
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

  /**
   * The promoting sibling of `editEntry` (issue #173, ADR 0048) — a
   * genuine Composer edit-commit runs Promotion exactly as `sendEntry`
   * does, because CONTEXT.md's Task entry draws no line between an Entry
   * that arrives with a bare checkbox already in it and one that gains
   * one on a later edit: "every checkbox written in an Entry is a Task."
   *
   * The promoted Task's own capture date is the EDITED Entry's own
   * `createdAt`, never "now" — ADR 0048's "a Task promoted from an Entry
   * takes the Entry's capture date" names the Entry, not the moment
   * Promotion happens to run, and an edit is explicitly not what moves an
   * Entry in History (CONTEXT.md's Entry entry: "editing an Entry does not
   * move it"). `store.getMany([id])` reads the authoritative row rather
   * than trusting whatever this Device's own `entries` cache happens to
   * still hold — correct even for an Entry old enough to have scrolled out
   * of History's loaded pages (issue #79).
   */
  const commitEntryEditMutation = useMutation({
    mutationFn: async ({
      id,
      body,
      promotion,
    }: {
      id: string;
      body: string;
      promotion?: ComposerPromotionContext;
    }) => {
      const [current] = await store.getMany([id]);
      // No `current` only if the Entry was removed or has not Synced to
      // this Device between the reader opening it for edit and committing
      // — `store.edit` below already no-ops against exactly that case
      // (ADR 0028's own tombstone guard), so this falls back to "now"
      // purely to give `upsertPromotedTasks` SOME valid timestamp for a
      // write that is about to no-op anyway, not because "now" is ever the
      // intended capture date for a real edit.
      const capturedAt = current?.createdAt ?? new Date().toISOString();
      const { quickAddOptions, active } = promotion ?? defaultPromotionContext();
      const { body: promotedBody, tasks: promoted } = promoteBareCheckboxes(
        body,
        mintId,
        quickAddOptions,
        active,
      );
      await upsertPromotedTasks(promoted, capturedAt);
      await store.edit(id, promotedBody);
      return promoted.length;
    },
    onSuccess: async (promotedCount) => {
      await afterLocalWrite();
      await afterPromotion(promotedCount);
    },
  });

  function commitEntryEdit(id: string, raw: string, promotion?: ComposerPromotionContext) {
    const body = normalizeEntryBody(raw);
    if (body === null) {
      return;
    }
    commitEntryEditMutation.mutate({ id, body, promotion });
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
    commitEntryEdit,
    removeEntry,
  };
}
