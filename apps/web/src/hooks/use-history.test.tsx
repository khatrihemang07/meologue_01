import type { Entry, EntryPage, EntryStore, TaskStore } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    getMany: vi.fn(async () => []),
  };
}

// Issue #172 / ADR 0051: useHistory takes a TaskStore purely to hand it
// through to requestSync (mocked above via `requestSyncMock`) — nothing
// in useHistory.ts itself ever calls a method on it, so a bare stub is
// enough for every test in this file.
function createFakeTaskStore(): TaskStore {
  return {
    list: vi.fn(async () => []),
    listByProject: vi.fn(async () => []),
    listChildren: vi.fn(async () => []),
    listInSection: vi.fn(async () => []),
    listDescendants: vi.fn(async () => []),
    listCompleted: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    upsert: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    uncomplete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    setDate: vi.fn(async () => {}),
    setDeadline: vi.fn(async () => {}),
    setDuration: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    setLabelIds: vi.fn(async () => {}),
    setProject: vi.fn(async () => {}),
    setSection: vi.fn(async () => {}),
    setParent: vi.fn(async () => {}),
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

  async function renderUseHistory(store: EntryStore, deviceId = "device-a") {
    const fresh = await importFresh();
    const taskStore = createFakeTaskStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook<ReturnType<typeof UseHistory>, void>(
      () => (fresh.useHistory as typeof UseHistory)(store, taskStore, deviceId),
      { wrapper },
    );
    return { fresh, ...rendered };
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
      expect(requestSyncMock).toHaveBeenCalledWith(store, expect.anything(), "device-a"),
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
        expect(requestSyncMock).toHaveBeenCalledWith(store, expect.anything(), "device-a"),
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
        expect(requestSyncMock).toHaveBeenCalledWith(store, expect.anything(), "device-a"),
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
