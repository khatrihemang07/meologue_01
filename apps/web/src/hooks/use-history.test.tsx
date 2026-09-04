import type {
  CommentStore,
  Entry,
  EntryPage,
  EntryStore,
  EventStore,
  LabelStore,
  ProjectStore,
  Task,
  TaskStore,
} from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceUtcOffsetMinutes, entryDayKey } from "@/lib/entry-day";
import { formatTaskReference } from "@/lib/inline-markdown";
import type { ComposerPromotionContext } from "@/lib/promote-tasks";
import { tokenSignature } from "@/lib/quick-add-highlight";
import type { useHistory as UseHistory } from "./use-history";

const { requestSyncMock } = vi.hoisted(() => ({
  requestSyncMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/sync-runner", () => ({ requestSync: requestSyncMock }));

// use-history.ts reaches for the `queryClient` singleton exported by
// lib/query-client.ts directly (not React context), so each test needs a
// fresh module registry, or a query cached by one test would leak into the
// next.
async function importFresh() {
  vi.resetModules();
  const [hook, client] = await Promise.all([import("./use-history"), import("@/lib/query-client")]);
  return { ...hook, ...client };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "now",
    seq: 3,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

function createFakeStore(): EntryStore {
  let entries: Entry[] = [];
  return {
    list: vi.fn(async () => entries),
    upsert: vi.fn(async (incoming: Entry[]) => {
      entries = [...entries, ...incoming];
    }),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    // `commitEntryEdit`'s own test below needs this to answer for real —
    // it reads the edited Entry's own `createdAt` off exactly this call
    // (use-history.ts's own comment on why "now" is only ever a fallback).
    getMany: vi.fn(async (ids: string[]) => entries.filter((e) => ids.includes(e.id))),
  };
}

// Issue #172 / ADR 0051 had useHistory take a TaskStore purely to hand it
// through to requestSync (mocked above via `requestSyncMock`). Issue #173
// changed that: Promotion now calls `list()`/`upsert()` on this directly
// (use-history.ts's `upsertPromotedTasks`), so this fake tracks its own
// `active` list the same way use-tasks.test.tsx's own `createFakeStore`
// does, rather than staying a bare stub — every test that doesn't send a
// checkbox line still never exercises either method beyond that.
function createFakeTaskStore(): TaskStore {
  let active: Task[] = [];
  return {
    list: vi.fn(async () => active),
    listByProject: vi.fn(async () => []),
    listChildren: vi.fn(async () => []),
    listInSection: vi.fn(async () => []),
    listDescendants: vi.fn(async () => []),
    listCompleted: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    upsert: vi.fn(async (incoming: Task[]) => {
      active = [...active, ...incoming];
    }),
    complete: vi.fn(async () => {}),
    uncomplete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    reorderToday: vi.fn(async () => {}),
    setDate: vi.fn(async () => {}),
    setDeadline: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    setLabelIds: vi.fn(async () => {}),
    setProject: vi.fn(async () => {}),
    setSection: vi.fn(async () => {}),
    setParent: vi.fn(async () => {}),
    setDescription: vi.fn(async () => {}),
    advanceRecurring: vi.fn(async () => {}),
    completeForever: vi.fn(async () => {}),
    postpone: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  };
}

describe("useHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    requestSyncMock.mockClear();
  });

  async function renderUseHistory(
    store: EntryStore,
    taskStore: TaskStore = createFakeTaskStore(),
    deviceId = "device-a",
    // Every test but Promotion's own label-resolution one has no
    // `%label` token to resolve — this default mirrors `useHistory`'s own
    // "no labels resolve to anything" fallback rather than duplicating it.
    resolveLabelIds: (names: string[]) => Promise<string[]> = async () => [],
  ) {
    const fresh = await importFresh();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    // Issue #182: `useHistory` now takes three more stores solely to pass
    // through to `requestSync` (use-history.ts's own doc comment) — this
    // suite mocks `requestSync` wholesale (`requestSyncMock` above), so
    // none of the three is ever actually called; a bare cast is enough to
    // satisfy the parameter's type without a full fake implementation.
    const projectStore = {} as ProjectStore;
    const labelStore = {} as LabelStore;
    const commentStore = {} as CommentStore;
    const eventStore = {} as EventStore;
    const rendered = renderHook<ReturnType<typeof UseHistory>, void>(
      () =>
        (fresh.useHistory as typeof UseHistory)(
          store,
          taskStore,
          projectStore,
          labelStore,
          commentStore,
          eventStore,
          deviceId,
          resolveLabelIds,
        ),
      { wrapper },
    );
    return { fresh, taskStore, ...rendered };
  }

  it("reads entries from the store", async () => {
    const store = createFakeStore();
    await store.upsert([
      {
        id: "1",
        deviceId: "device-a",
        body: "hello",
        createdAt: "now",
        seq: null,
        syncedAt: null,
        deletedAt: null,
      },
    ]);

    const { result } = await renderUseHistory(store);

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries.map((entry) => entry.body)).toEqual(["hello"]);
  });

  it("ignores blank input without touching the store", async () => {
    const store = createFakeStore();
    const { result } = await renderUseHistory(store);
    await waitFor(() => expect(result.current.entries).toEqual([]));

    act(() => result.current.sendEntry("   "));

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("shows a sent Entry in entries without waiting on sync", async () => {
    const store = createFakeStore();
    const { result } = await renderUseHistory(store);
    await waitFor(() => expect(result.current.entries).toEqual([]));

    act(() => result.current.sendEntry("hello"));

    await waitFor(() => expect(result.current.entries.map((e) => e.body)).toEqual(["hello"]));
    expect(store.upsert).toHaveBeenCalledWith([
      expect.objectContaining({ body: "hello", deviceId: "device-a" }),
    ]);
  });

  it("nudges the sync loop to run right away after Sending, rather than waiting for its next tick", async () => {
    const store = createFakeStore();
    const { result } = await renderUseHistory(store);
    await waitFor(() => expect(result.current.entries).toEqual([]));

    act(() => result.current.sendEntry("hello"));

    await waitFor(() =>
      expect(requestSyncMock).toHaveBeenCalledWith(expect.objectContaining({ store }), "device-a"),
    );
  });

  describe("editEntry (ADR 0028)", () => {
    it("changes the Entry's body through the store and pushes the change", async () => {
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.editEntry("1", "an edited body"));

      await waitFor(() => expect(store.edit).toHaveBeenCalledWith("1", "an edited body"));
      await waitFor(() =>
        expect(requestSyncMock).toHaveBeenCalledWith(
          expect.objectContaining({ store }),
          "device-a",
        ),
      );
    });

    it("trims the body the same way sendEntry does", async () => {
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.editEntry("1", "  padded  "));

      await waitFor(() => expect(store.edit).toHaveBeenCalledWith("1", "padded"));
    });

    it("refuses an edit to empty/whitespace without touching the store", async () => {
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.editEntry("1", "   "));

      expect(store.edit).not.toHaveBeenCalled();
      expect(requestSyncMock).not.toHaveBeenCalled();
    });
  });

  describe("removeEntry (ADR 0028)", () => {
    it("removes the Entry through the store by id and pushes the tombstone", async () => {
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.removeEntry(entry({ id: "7" })));

      await waitFor(() => expect(store.remove).toHaveBeenCalledWith("7"));
      await waitFor(() =>
        expect(requestSyncMock).toHaveBeenCalledWith(
          expect.objectContaining({ store }),
          "device-a",
        ),
      );
    });

    // Issue #82 removed the Undo toast and its restore mutation: with a
    // confirm dialog now in front of Delete (entry-actions.tsx's
    // ConfirmDialog), removeEntry itself is trusted to delete
    // unconditionally the moment it's called, and offers no way back —
    // see use-history.ts's own comment on removeEntry for the full
    // reasoning, and its comment just above this mutation for why a
    // restore path can never safely reuse the deleted id even if one were
    // added back.
    it("does not offer an Undo — deletes unconditionally, with no restore path", async () => {
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.removeEntry(entry({ id: "7" })));

      await waitFor(() => expect(store.remove).toHaveBeenCalledWith("7"));
      // No restore call of any kind — store.upsert() is only ever used by
      // sendEntry, never by removeEntry.
      expect(store.upsert).not.toHaveBeenCalled();
    });

    // ADR 0048's asymmetric deletion, proven at the write path rather than
    // merely inferred from the diff — the mirror of use-tasks.test.tsx's
    // own "never touches the Entry store when removing a Task": deleting
    // an Entry must never reach across into the Task store at all, so
    // every Task it referenced is left completely untouched.
    it("never touches the Task store — deletion is asymmetric (ADR 0048)", async () => {
      const store = createFakeStore();
      const { result, taskStore } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.removeEntry(entry({ id: "7" })));

      await waitFor(() => expect(store.remove).toHaveBeenCalledWith("7"));
      for (const [name, method] of Object.entries(taskStore)) {
        expect(vi.mocked(method), `taskStore.${name} was called`).not.toHaveBeenCalled();
      }
    });
  });

  // Promotion (issue #173, ADR 0048): sending or committing an Entry
  // containing a bare `- [ ]` mints a Task for it and rewrites that line
  // as a Reference.
  //
  // `mustFirstCall`/`mustAt` exist for the same reason entry-document.test.ts's
  // own `nodeType` helper does — noUncheckedIndexedAccess makes a mock's
  // `.calls[0]` and an array's own `[0]` both possibly `undefined`, and
  // these throw rather than sprinkling non-null assertions (which Biome's
  // `recommended` refuses) through every test below.
  function mustFirstCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T {
    const call = mock.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the mock to have been called");
    }
    return call;
  }

  function mustAt<T>(items: readonly T[], index: number): T {
    const value = items[index];
    if (value === undefined) {
      throw new Error(`expected an element at index ${index}`);
    }
    return value;
  }

  describe("Promotion", () => {
    it("mints a Task for a bare checkbox and rewrites the line as a Reference", async () => {
      const store = createFakeStore();
      const { result, taskStore } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.sendEntry("- [ ] buy milk"));

      await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
      const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
      expect(mintedTasks).toHaveLength(1);
      const task = mustAt(mintedTasks, 0);
      expect(task.content).toBe("buy milk");
      expect(task.completedAt).toBeNull();

      await waitFor(() => expect(store.upsert).toHaveBeenCalledTimes(1));
      const [sentEntries] = mustFirstCall(vi.mocked(store.upsert));
      expect(mustAt(sentEntries, 0).body).toBe(`- [ ] ${formatTaskReference(task.id, "buy milk")}`);
    });

    it("a promoted Task takes the Entry's own capture date, day-only", async () => {
      const store = createFakeStore();
      const { result, taskStore } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.sendEntry("- [ ] buy milk"));

      await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
      const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
      const [sentEntries] = mustFirstCall(vi.mocked(store.upsert));
      const sentEntry = mustAt(sentEntries, 0);
      const task = mustAt(mintedTasks, 0);
      expect(task.date).toBe(entryDayKey(sentEntry.createdAt, deviceUtcOffsetMinutes()));
    });

    it("checks the ticked marker too — `- [x]` mints an already-completed Task", async () => {
      const store = createFakeStore();
      const { result, taskStore } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.sendEntry("- [x] done already"));

      await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
      const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
      expect(mustAt(mintedTasks, 0).completedAt).not.toBeNull();
    });

    it("does not mint a second Task for a line that is already a Reference — the loop guard", async () => {
      const store = createFakeStore();
      const { result, taskStore } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));
      const taskId = "0192abcd-1234-7890-abcd-0123456789ac";

      act(() =>
        result.current.sendEntry(`- [ ] ${formatTaskReference(taskId, "already promoted")}`),
      );

      await waitFor(() => expect(store.upsert).toHaveBeenCalledTimes(1));
      expect(taskStore.upsert).not.toHaveBeenCalled();
      const [sentEntries] = mustFirstCall(vi.mocked(store.upsert));
      expect(mustAt(sentEntries, 0).body).toBe(
        `- [ ] ${formatTaskReference(taskId, "already promoted")}`,
      );
    });

    it("does nothing to the Task store for an ordinary Entry with no checkbox", async () => {
      const store = createFakeStore();
      const { result, taskStore } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.sendEntry("just a thought, no checkbox"));

      await waitFor(() => expect(store.upsert).toHaveBeenCalledTimes(1));
      expect(taskStore.upsert).not.toHaveBeenCalled();
    });

    // Issue #173's own follow-up: the checkbox line must genuinely "file
    // itself" — a recognised date/priority token resolves into the
    // minted Task's own fields, not just into words stripped from its
    // name. `promote-tasks.test.ts` already covers the parse itself in
    // isolation; these prove the WIRING through `sendEntry` end to end,
    // the seam a unit test on `promoteBareCheckboxes` alone cannot catch
    // (a wrong argument order, a dropped `quickAddOptions`, and so on).
    describe("the checkbox line files itself (issue #173 follow-up)", () => {
      const PROMOTION: ComposerPromotionContext = {
        quickAddOptions: { now: "2026-09-02", smartDates: true },
        active: null,
      };

      it("resolves a date token and a priority token into the minted Task's own fields", async () => {
        const store = createFakeStore();
        const { result, taskStore } = await renderUseHistory(store);
        await waitFor(() => expect(result.current.entries).toEqual([]));

        act(() => result.current.sendEntry("- [ ] buy milk tomorrow p1", PROMOTION));

        await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
        const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
        const task = mustAt(mintedTasks, 0);
        expect(task.content).toBe("buy milk");
        expect(task.date).toBe("2026-09-03");
        expect(task.priority).toBe(4);

        const [sentEntries] = mustFirstCall(vi.mocked(store.upsert));
        expect(mustAt(sentEntries, 0).body).toBe(
          `- [ ] ${formatTaskReference(task.id, "buy milk")}`,
        );
      });

      it("resolves a %label token through the injected resolveLabelIds, the same round trip Todo's own add field uses", async () => {
        const store = createFakeStore();
        const resolveLabelIds = vi.fn(async (names: string[]) => names.map((n) => `label-${n}`));
        const { result, taskStore } = await renderUseHistory(
          store,
          createFakeTaskStore(),
          "device-a",
          resolveLabelIds,
        );
        await waitFor(() => expect(result.current.entries).toEqual([]));

        act(() => result.current.sendEntry("- [ ] buy milk %Shopping", PROMOTION));

        await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
        expect(resolveLabelIds).toHaveBeenCalledWith(["Shopping"]);
        const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
        expect(mustAt(mintedTasks, 0).labelIds).toEqual(["label-Shopping"]);
      });

      it("does not consume a token the reader demoted in the Composer before Send", async () => {
        const store = createFakeStore();
        const { result, taskStore } = await renderUseHistory(store);
        await waitFor(() => expect(result.current.entries).toEqual([]));
        const demotedTomorrow: ComposerPromotionContext = {
          quickAddOptions: PROMOTION.quickAddOptions,
          active: {
            ordinal: 0,
            demoted: new Set([tokenSignature({ kind: "date", raw: "tomorrow" })]),
          },
        };

        act(() => result.current.sendEntry("- [ ] buy milk tomorrow p1", demotedTomorrow));

        await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
        const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
        const task = mustAt(mintedTasks, 0);
        // "tomorrow" survives as plain content, exactly as the reader saw
        // it once they clicked to demote it; "p1" was never demoted, so
        // it's still recognised.
        expect(task.content).toBe("buy milk tomorrow");
        expect(task.priority).toBe(4);
        const [sentEntries] = mustFirstCall(vi.mocked(store.upsert));
        expect(mustAt(sentEntries, 0).body).toBe(
          `- [ ] ${formatTaskReference(task.id, "buy milk tomorrow")}`,
        );
      });

      it("falls back to the Entry's own capture date when nothing parses, still the unchanged capture-date rule", async () => {
        const store = createFakeStore();
        const { result, taskStore } = await renderUseHistory(store);
        await waitFor(() => expect(result.current.entries).toEqual([]));

        act(() => result.current.sendEntry("- [ ] buy milk", PROMOTION));

        await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
        const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
        const [sentEntries] = mustFirstCall(vi.mocked(store.upsert));
        const sentEntry = mustAt(sentEntries, 0);
        expect(mustAt(mintedTasks, 0).date).toBe(
          entryDayKey(sentEntry.createdAt, deviceUtcOffsetMinutes()),
        );
      });
    });

    describe("commitEntryEdit — the Composer's own promoting edit-commit door", () => {
      it("promotes a bare checkbox added on edit, exactly as a fresh Send does", async () => {
        const store = createFakeStore();
        await store.upsert([entry({ id: "existing", body: "old body" })]);
        const { result, taskStore } = await renderUseHistory(store);
        await waitFor(() => expect(result.current.entries).toHaveLength(1));

        act(() => result.current.commitEntryEdit("existing", "- [ ] buy milk"));

        await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
        const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
        const task = mustAt(mintedTasks, 0);
        expect(task.content).toBe("buy milk");
        await waitFor(() => expect(store.edit).toHaveBeenCalledTimes(1));
        expect(store.edit).toHaveBeenCalledWith(
          "existing",
          `- [ ] ${formatTaskReference(task.id, "buy milk")}`,
        );
      });

      it("takes the EDITED Entry's own capture date, never 'now'", async () => {
        const store = createFakeStore();
        const capturedAt = "2020-03-01T00:00:00.000Z";
        await store.upsert([entry({ id: "existing", body: "old body", createdAt: capturedAt })]);
        const { result, taskStore } = await renderUseHistory(store);
        await waitFor(() => expect(result.current.entries).toHaveLength(1));

        act(() => result.current.commitEntryEdit("existing", "- [ ] buy milk"));

        await waitFor(() => expect(taskStore.upsert).toHaveBeenCalledTimes(1));
        const [mintedTasks] = mustFirstCall(vi.mocked(taskStore.upsert));
        expect(mustAt(mintedTasks, 0).date).toBe(entryDayKey(capturedAt, deviceUtcOffsetMinutes()));
      });

      it("does not promote a bare checkbox already there before the edit twice over — the loop guard holds across edits too", async () => {
        const store = createFakeStore();
        const taskId = "0192abcd-1234-7890-abcd-0123456789ac";
        await store.upsert([
          entry({
            id: "existing",
            body: `- [ ] ${formatTaskReference(taskId, "already promoted")}`,
          }),
        ]);
        const { result, taskStore } = await renderUseHistory(store);
        await waitFor(() => expect(result.current.entries).toHaveLength(1));

        act(() =>
          result.current.commitEntryEdit(
            "existing",
            `- [ ] ${formatTaskReference(taskId, "already promoted")}\n\nedited to add a line`,
          ),
        );

        await waitFor(() => expect(store.edit).toHaveBeenCalledTimes(1));
        expect(taskStore.upsert).not.toHaveBeenCalled();
      });
    });
  });

  // Issue #79: a fresh open reads one page, and fetchMore widens by one
  // more. A page-aware fake (unlike createFakeStore above, whose list()
  // ignores its argument entirely and is what every other test in this
  // file relies on staying untouched) is what makes "the right cursor
  // reached the store" and "hasMore turns false once list() runs out"
  // observable here — the paging semantics of `before`/`limit` themselves
  // are packages/core's own contract suite's job
  // (entry-store-contract.ts), not this file's.
  describe("pagination (issue #79)", () => {
    function pagedEntry(index: number): Entry {
      // Newest first (higher index = newer), matching list()'s own order —
      // createdAt spaced a day apart so string comparison sorts the same
      // way a real timestamp comparison would.
      return entry({
        id: String(index).padStart(4, "0"),
        createdAt: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String(
          (index % 28) + 1,
        ).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    // Mirrors how SqliteEntryStore/InMemoryEntryStore both apply
    // `before`/`limit` (see packages/core's own contract suite for the
    // real thing being tested) — just enough of it, in one place, for this
    // file's fake stores to apply consistently.
    function pagedList(all: Entry[], page?: EntryPage): Entry[] {
      let result = all;
      if (page?.before) {
        const { createdAt, id } = page.before;
        result = result.filter((e) =>
          e.createdAt !== createdAt ? e.createdAt < createdAt : e.id < id,
        );
      }
      return page?.limit === undefined ? result : result.slice(0, page.limit);
    }

    function fakeStoreWithList(list: EntryStore["list"]): EntryStore {
      return {
        list,
        upsert: vi.fn(async () => {}),
        pending: vi.fn(async () => []),
        getCursor: vi.fn(async () => 0),
        setCursor: vi.fn(async () => {}),
        search: vi.fn(async () => []),
        edit: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        getMany: vi.fn(async () => []),
      };
    }

    function createPagedFakeStore(count: number): EntryStore {
      // Newest-first, mirroring list()'s own order (ADR 0014) — built
      // once, descending, so `before`/`limit` can be applied the same way
      // SqliteEntryStore and InMemoryEntryStore both apply them.
      const all = Array.from({ length: count }, (_, i) => pagedEntry(count - 1 - i));
      return fakeStoreWithList(vi.fn(async (page) => pagedList(all, page)));
    }

    it("a fresh open reads only the newest page, not the whole History", async () => {
      const store = createPagedFakeStore(75);
      const { result } = await renderUseHistory(store);

      await waitFor(() => expect(result.current.entries).toHaveLength(50));

      expect(result.current.entries[0]?.id).toBe("0074");
      expect(result.current.entries[49]?.id).toBe("0025");
      expect(result.current.pagination.hasMore).toBe(true);
    });

    it("reports no more pages when the whole History fits in one page", async () => {
      const store = createPagedFakeStore(10);
      const { result } = await renderUseHistory(store);

      await waitFor(() => expect(result.current.entries).toHaveLength(10));

      expect(result.current.pagination.hasMore).toBe(false);
    });

    it("fetchMore widens by one older page, using the oldest loaded Entry as the cursor", async () => {
      const store = createPagedFakeStore(75);
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toHaveLength(50));

      act(() => result.current.pagination.fetchMore());

      await waitFor(() => expect(result.current.entries).toHaveLength(75));
      // Still newest-first end to end, with no gap or overlap at the seam.
      expect(result.current.entries[49]?.id).toBe("0025");
      expect(result.current.entries[50]?.id).toBe("0024");
      expect(result.current.entries[74]?.id).toBe("0000");
      expect(result.current.pagination.hasMore).toBe(false);
      expect(store.list).toHaveBeenLastCalledWith({
        before: { createdAt: pagedEntry(25).createdAt, id: "0025" },
        limit: 50,
      });
    });

    it("fetching is true only while an older page is actually in flight", async () => {
      const all = Array.from({ length: 75 }, (_, i) => pagedEntry(75 - 1 - i));
      let resolveOlderPage: (entries: Entry[]) => void = () => {};
      let calls = 0;
      const store = fakeStoreWithList(
        vi.fn(async (page) => {
          calls++;
          if (calls === 1) {
            // The initial page — resolves immediately, same as every
            // other test in this file.
            return pagedList(all, page);
          }
          // The older page fetchMore triggers below — held open until the
          // test resolves it explicitly.
          return new Promise<Entry[]>((resolve) => {
            resolveOlderPage = resolve;
          });
        }),
      );
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toHaveLength(50));
      expect(result.current.pagination.fetching).toBe(false);

      act(() => result.current.pagination.fetchMore());
      await waitFor(() => expect(result.current.pagination.fetching).toBe(true));

      act(() =>
        resolveOlderPage(
          pagedList(all, {
            before: { createdAt: pagedEntry(25).createdAt, id: "0025" },
            limit: 50,
          }),
        ),
      );

      await waitFor(() => expect(result.current.pagination.fetching).toBe(false));
      expect(result.current.entries).toHaveLength(75);
    });
  });
});
