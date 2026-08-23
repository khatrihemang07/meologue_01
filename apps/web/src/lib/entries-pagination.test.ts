import type { Entry, EntryStore } from "@meologue/core";
import { describe, expect, it, vi } from "vitest";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";

// entries-pagination.ts reaches for the `queryClient` singleton exported by
// lib/query-client.ts directly (not React context), same as use-history.ts
// and sync-runner.ts — each test needs a fresh module registry, or a query
// cached by one test would leak into the next (the same pattern
// use-history.test.tsx and sync-runner.test.ts already use).
async function importFresh() {
  vi.resetModules();
  const [pagination, client] = await Promise.all([
    import("./entries-pagination"),
    import("./query-client"),
  ]);
  return { ...pagination, ...client };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function createFakeStore(list: EntryStore["list"]): EntryStore {
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

describe("nextEntriesPageParam", () => {
  it("returns undefined once a page comes back shorter than the page size — nothing older left", async () => {
    const { nextEntriesPageParam, ENTRIES_PAGE_SIZE } = await importFresh();
    const shortPage = Array.from({ length: ENTRIES_PAGE_SIZE - 1 }, (_, i) =>
      entry({ id: String(i) }),
    );

    expect(nextEntriesPageParam(shortPage)).toBeUndefined();
  });

  it("a full page's cursor is the oldest (last) loaded Entry's createdAt and id", async () => {
    const { nextEntriesPageParam, ENTRIES_PAGE_SIZE } = await importFresh();
    const fullPage = Array.from({ length: ENTRIES_PAGE_SIZE }, (_, i) =>
      entry({
        id: String(i),
        createdAt: `2026-01-${String(30 - i).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const oldest = fullPage[fullPage.length - 1] as Entry;

    expect(nextEntriesPageParam(fullPage)).toEqual({
      before: { createdAt: oldest.createdAt, id: oldest.id },
      limit: ENTRIES_PAGE_SIZE,
    });
  });
});

describe("refreshNewestEntriesPage", () => {
  it("does nothing when History's query has never been observed", async () => {
    const { refreshNewestEntriesPage } = await importFresh();
    const list = vi.fn(async () => []);
    const store = createFakeStore(list);

    await refreshNewestEntriesPage(store);

    expect(list).not.toHaveBeenCalled();
  });

  it("with only one page loaded, refetches the freshest page-size worth of Entries", async () => {
    const { refreshNewestEntriesPage, queryClient, ENTRIES_PAGE_SIZE } = await importFresh();
    const original = [entry({ id: "1" })];
    queryClient.setQueryData(ENTRIES_QUERY_KEY, {
      pages: [original],
      pageParams: [{ limit: ENTRIES_PAGE_SIZE }],
    });
    const refreshed = [
      entry({ id: "1" }),
      entry({ id: "2", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const list = vi.fn(async () => refreshed);
    const store = createFakeStore(list);

    await refreshNewestEntriesPage(store);

    expect(list).toHaveBeenCalledWith({ limit: ENTRIES_PAGE_SIZE });
    expect(queryClient.getQueryData(ENTRIES_QUERY_KEY)).toEqual({
      pages: [refreshed],
      pageParams: [{ limit: ENTRIES_PAGE_SIZE }],
    });
  });

  // The correctness-critical case: with a second page already loaded, a
  // refresh must re-read exactly "everything newer than where page two
  // starts" (page two's own `before` cursor, unbounded) rather than a fixed
  // page-size count — otherwise an Entry deleted from page one would pull
  // the boundary Entry from page two into the refreshed page one too,
  // duplicating it in the flattened list. See refreshNewestEntriesPage's
  // own doc comment (entries-pagination.ts) for the full reasoning.
  it("with more pages loaded, bounds the refresh by the next page's own cursor, not a fixed count — no duplicate or gap", async () => {
    const { refreshNewestEntriesPage, queryClient, ENTRIES_PAGE_SIZE } = await importFresh();
    const boundary = { createdAt: "2026-01-05T00:00:00.000Z", id: "boundary" };
    const pageOne = [entry({ id: "1" })];
    const pageTwo = [entry({ id: "2" })];
    queryClient.setQueryData(ENTRIES_QUERY_KEY, {
      pages: [pageOne, pageTwo],
      pageParams: [{ limit: ENTRIES_PAGE_SIZE }, { before: boundary, limit: ENTRIES_PAGE_SIZE }],
    });
    const refreshedPageOne = [entry({ id: "1" }), entry({ id: "3" })];
    const list = vi.fn(async () => refreshedPageOne);
    const store = createFakeStore(list);

    await refreshNewestEntriesPage(store);

    // No `limit` — bounded only by the cursor page two already committed
    // to, so however many Entries now fall in that range come back.
    expect(list).toHaveBeenCalledWith({ before: boundary });
    const cached = queryClient.getQueryData(ENTRIES_QUERY_KEY) as {
      pages: Entry[][];
      pageParams: unknown[];
    };
    // Only page one's content changed; page two, and every pageParam,
    // survive untouched.
    expect(cached.pages).toEqual([refreshedPageOne, pageTwo]);
    expect(cached.pageParams).toEqual([
      { limit: ENTRIES_PAGE_SIZE },
      { before: boundary, limit: ENTRIES_PAGE_SIZE },
    ]);
  });

  it("also invalidates an active Search's own query, so it catches up too", async () => {
    const { refreshNewestEntriesPage, queryClient, ENTRIES_PAGE_SIZE } = await importFresh();
    queryClient.setQueryData(ENTRIES_QUERY_KEY, {
      pages: [[entry()]],
      pageParams: [{ limit: ENTRIES_PAGE_SIZE }],
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const store = createFakeStore(vi.fn(async () => [entry()]));

    await refreshNewestEntriesPage(store);

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: [...ENTRIES_QUERY_KEY, "search"],
    });
  });
});
