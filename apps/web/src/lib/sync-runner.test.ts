import type {
  CommentStore,
  Entry,
  EntryStore,
  EventStore,
  LabelStore,
  ProjectStore,
  TaskStore,
} from "@meologue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRIES_QUERY_KEY, TASKS_QUERY_KEY } from "@/lib/query-keys";
import { useSettingsStore } from "@/lib/settings";

const { syncMock } = vi.hoisted(() => ({ syncMock: vi.fn(async () => {}) }));

vi.mock("@meologue/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meologue/core")>();
  return { ...actual, sync: syncMock };
});

// sync-runner.ts reaches for the `queryClient` singleton exported by
// lib/query-client.ts directly, and keeps its own coalescing state
// (`syncInFlight`, `rerunRequested`) at module scope — each test needs a
// fresh module registry, or state from one test would leak into the next.
async function importFresh() {
  vi.resetModules();
  // sync-status.ts and query-client.ts are imported alongside sync-runner.ts
  // (not just relied on via a stale top-level reference) for the same
  // reason use-sync-loop.test.tsx imports lib/query-client fresh with
  // use-sync-loop: resetModules() gives the freshly-imported sync-runner
  // its own new Zustand store and QueryClient instances, and a test
  // asserting against the old top-level import would be watching a
  // different object that the code under test never touches.
  const [runner, status, client] = await Promise.all([
    import("./sync-runner"),
    import("./sync-status"),
    import("./query-client"),
  ]);
  return { ...runner, ...status, ...client };
}

function createFakeStore(): EntryStore {
  return {
    list: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    getMany: vi.fn(async () => []),
  };
}

// Issue #172 / ADR 0051: requestSync carries both streams — a bare stub
// suffices here, since `sync()` itself is mocked (`syncMock` above) and
// every test in this file is only checking that `requestSync` coalesces
// calls and reports status correctly, not exercising real TaskStore
// behaviour.
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
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  };
}

// Issue #182: three more stores requestSync's own SyncStores bag needs —
// bare casts suffice here, the same reasoning createFakeTaskStore's own
// comment gives: sync() itself is mocked, so nothing ever calls into
// these beyond handing them back to the mock.
function fakeProjectStore(): ProjectStore {
  return {} as ProjectStore;
}
function fakeLabelStore(): LabelStore {
  return {} as LabelStore;
}
function fakeCommentStore(): CommentStore {
  return {} as CommentStore;
}
// Issue #184: the seventh store requestSync's own SyncStores bag needs.
function fakeEventStore(): EventStore {
  return {} as EventStore;
}

describe("requestSync", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setServerUrl("https://server.example");
    syncMock.mockClear();
  });

  it("runs a sync when a Server URL is configured", async () => {
    const { requestSync } = await importFresh();
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    const projectStore = fakeProjectStore();
    const labelStore = fakeLabelStore();
    const commentStore = fakeCommentStore();
    const eventStore = fakeEventStore();

    await requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({ store, taskStore, deviceId: "device-a" }),
    );
  });

  it("does nothing with no Server URL configured (ADR 0011)", async () => {
    useSettingsStore.getState().setServerUrl("");
    const { requestSync } = await importFresh();
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    const projectStore = fakeProjectStore();
    const labelStore = fakeLabelStore();
    const commentStore = fakeCommentStore();
    const eventStore = fakeEventStore();

    await requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent callers into a single in-flight sync", async () => {
    const { requestSync } = await importFresh();
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    const projectStore = fakeProjectStore();
    const labelStore = fakeLabelStore();
    const commentStore = fakeCommentStore();
    const eventStore = fakeEventStore();
    let resolveSync: () => void = () => {};
    syncMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
    );

    const first = requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );
    const second = requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );
    expect(syncMock).toHaveBeenCalledTimes(1);

    resolveSync();
    await Promise.all([first, second]);
  });

  // The bug this regression-tests: a caller (e.g. a Send) that arrives while
  // a sync is already in flight must not be silently folded into that
  // earlier run — the earlier run may have already read the store's pending
  // Entries before this caller's Entry existed, so its promise resolving
  // doesn't mean this caller's Entry was actually pushed.
  it("runs once more for a caller that arrives mid-flight, rather than dropping it", async () => {
    const { requestSync } = await importFresh();
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    const projectStore = fakeProjectStore();
    const labelStore = fakeLabelStore();
    const commentStore = fakeCommentStore();
    const eventStore = fakeEventStore();
    let resolveFirst: () => void = () => {};
    syncMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const first = requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );
    expect(syncMock).toHaveBeenCalledTimes(1);

    // Arrives while the first run is still in flight.
    const second = requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );
    resolveFirst();
    await Promise.all([first, second]);

    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  it("never runs two syncs concurrently, even across a mid-flight rerun", async () => {
    const { requestSync } = await importFresh();
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    const projectStore = fakeProjectStore();
    const labelStore = fakeLabelStore();
    const commentStore = fakeCommentStore();
    const eventStore = fakeEventStore();
    let concurrent = 0;
    let maxConcurrent = 0;
    syncMock.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      concurrent--;
    });

    const first = requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );
    const second = requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
    );
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  // Ticket 40: a failed sync attempt is no longer swallowed after only a
  // console.error — it's recorded to sync-status.ts so the ambient indicator
  // and Settings can show it, and clears again the moment a later attempt
  // succeeds, with no reload.
  describe("sync status", () => {
    it("records a successful attempt", async () => {
      const { requestSync, useSyncStatusStore } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );

      expect(useSyncStatusStore.getState().lastAttempt).toEqual({
        url: "https://server.example",
        outcome: "working",
      });
    });

    it("records a failed attempt with the error's reason, without throwing out of requestSync", async () => {
      const { requestSync, useSyncStatusStore } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      syncMock.mockRejectedValueOnce(new Error("sync request failed with status 500"));

      await expect(
        requestSync(
          { store, taskStore, projectStore, labelStore, commentStore, eventStore },
          "device-a",
        ),
      ).resolves.toBeUndefined();

      expect(useSyncStatusStore.getState().lastAttempt).toEqual({
        url: "https://server.example",
        outcome: "failing",
        reason: "sync request failed with status 500",
      });
      expect(consoleError).toHaveBeenCalled();
    });

    it("clears a recorded failure once a later attempt succeeds", async () => {
      const { requestSync, useSyncStatusStore } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();
      vi.spyOn(console, "error").mockImplementation(() => {});
      syncMock.mockRejectedValueOnce(new Error("boom"));

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );
      expect(useSyncStatusStore.getState().lastAttempt?.outcome).toBe("failing");

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );

      expect(useSyncStatusStore.getState().lastAttempt).toEqual({
        url: "https://server.example",
        outcome: "working",
      });
    });

    it("records nothing with no Server URL configured", async () => {
      useSettingsStore.getState().setServerUrl("");
      const { requestSync, useSyncStatusStore } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );

      expect(useSyncStatusStore.getState().lastAttempt).toBeNull();
    });
  });

  // Issue #79: a successful sync used to invalidate the whole entries
  // query key, which against an infinite query refetches every page
  // currently held. This is what proves the replacement
  // (refreshNewestEntriesPage, entries-pagination.ts) is actually wired
  // in here — the boundary-aware refresh logic itself has its own
  // dedicated tests in entries-pagination.test.ts.
  describe("entries cache refresh (issue #79)", () => {
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

    it("on success, refreshes only the newest loaded page, leaving older loaded pages untouched", async () => {
      const { requestSync, queryClient } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();
      const boundary = { createdAt: "2026-01-05T00:00:00.000Z", id: "boundary" };
      const pageOne = [entry({ id: "old-1" })];
      const pageTwo = [entry({ id: "old-2" })];
      queryClient.setQueryData(ENTRIES_QUERY_KEY, {
        pages: [pageOne, pageTwo],
        pageParams: [{ limit: 50 }, { before: boundary, limit: 50 }],
      });
      const refreshedPageOne = [entry({ id: "old-1" }), entry({ id: "new-from-sync" })];
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(refreshedPageOne);

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );

      // Bounded by the second page's own cursor, not a fixed page size —
      // see refreshNewestEntriesPage's own doc comment for why.
      expect(store.list).toHaveBeenCalledWith({ before: boundary });
      expect(queryClient.getQueryData(ENTRIES_QUERY_KEY)).toEqual({
        pages: [refreshedPageOne, pageTwo],
        pageParams: [{ limit: 50 }, { before: boundary, limit: 50 }],
      });
    });

    it("leaves the entries cache untouched when sync fails", async () => {
      const { requestSync } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();
      vi.spyOn(console, "error").mockImplementation(() => {});
      syncMock.mockRejectedValueOnce(new Error("boom"));

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );

      // list() is never called by requestSync's own refresh path when
      // sync() itself throws first — the refresh only runs after a
      // successful sync().
      expect(store.list).not.toHaveBeenCalled();
    });
  });

  // Issue #177: before this fix, `runSyncOnce` refreshed Entries
  // (`refreshNewestEntriesPage`, just above) but never invalidated
  // `TASKS_QUERY_KEY` — a Task pulled from another Device during a sync
  // sat in the store correctly but stayed invisible in Todo (a stale
  // TanStack Query cache) until something else happened to invalidate it,
  // most reliably a reload.
  describe("tasks cache refresh (issue #177)", () => {
    it("on success, invalidates the Tasks query so a Task pulled from another Device shows without a reload", async () => {
      const { requestSync, queryClient } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: TASKS_QUERY_KEY });
    });

    it("leaves the tasks cache untouched when sync fails", async () => {
      const { requestSync, queryClient } = await importFresh();
      const store = createFakeStore();
      const taskStore = createFakeTaskStore();
      const projectStore = fakeProjectStore();
      const labelStore = fakeLabelStore();
      const commentStore = fakeCommentStore();
      const eventStore = fakeEventStore();
      vi.spyOn(console, "error").mockImplementation(() => {});
      syncMock.mockRejectedValueOnce(new Error("boom"));
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      await requestSync(
        { store, taskStore, projectStore, labelStore, commentStore, eventStore },
        "device-a",
      );

      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });
});
