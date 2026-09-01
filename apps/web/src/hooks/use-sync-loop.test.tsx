import type { Entry, EntryStore, TaskStore } from "@meologue/core";
import { QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { useSettingsStore } from "@/lib/settings";

const { syncMock, openEntryStoreMock, isTabVisibleMock, subscribeToWakeEventsMock } = vi.hoisted(
  () => ({
    syncMock: vi.fn(async () => {}),
    openEntryStoreMock: vi.fn(),
    isTabVisibleMock: vi.fn(() => true),
    subscribeToWakeEventsMock: vi.fn((_wake: () => void) => () => {}),
  }),
);

vi.mock("@meologue/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meologue/core")>();
  return { ...actual, sync: syncMock };
});

// A stand-in for entry-store-layout.tsx's real entryStoreQueryOptions
// (which needs a real SqliteDriver to run migrations against) — same
// shape, `openEntryStoreMock` in place of the real `openEntryStore`.
vi.mock("@/pages/entry-store-layout", () => ({
  entryStoreQueryOptions: queryOptions({
    queryKey: ENTRY_STORE_QUERY_KEY,
    queryFn: openEntryStoreMock,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
  }),
}));

vi.mock("@/platform/wake-signals", () => ({
  isTabVisible: isTabVisibleMock,
  subscribeToWakeEvents: subscribeToWakeEventsMock,
}));

function createFakeStore(): EntryStore {
  return {
    list: vi.fn(async () => [] as Entry[]),
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

// Issue #172 / ADR 0051 — see sync-runner.test.ts's own
// createFakeTaskStore for why a bare stub is enough: `sync()` itself is
// mocked (`syncMock` above), so nothing here exercises real TaskStore
// behaviour, only that SyncLoop hands one through to requestSync.
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

// SyncLoop reaches for the `queryClient` singleton exported by
// lib/query-client.ts directly (not React context), so each test needs a
// fresh module registry, or a query cached by one test would leak into the
// next.
async function importFresh() {
  vi.resetModules();
  const [loop, client] = await Promise.all([
    import("./use-sync-loop"),
    import("@/lib/query-client"),
  ]);
  return { ...loop, ...client };
}

async function renderSyncLoop() {
  const fresh = await importFresh();
  render(
    <QueryClientProvider client={fresh.queryClient}>
      <fresh.SyncLoop />
    </QueryClientProvider>,
  );
  return fresh;
}

describe("SyncLoop", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setServerUrl("");
    // mockReset, not mockClear: a test further down overrides
    // syncMock's implementation with one that never resolves on its own —
    // mockClear only forgets call history, leaving that implementation to
    // leak into (and hang) the next test's sync attempts.
    syncMock.mockReset();
    syncMock.mockImplementation(async () => {});
    openEntryStoreMock.mockReset();
    isTabVisibleMock.mockReset();
    isTabVisibleMock.mockReturnValue(true);
    subscribeToWakeEventsMock.mockReset();
    subscribeToWakeEventsMock.mockImplementation(() => () => {});
  });

  it("makes no sync request while the store has not resolved, Server URL or not", async () => {
    openEntryStoreMock.mockReturnValue(new Promise(() => {}));
    useSettingsStore.getState().setServerUrl("https://server.example");

    await renderSyncLoop();
    await waitFor(() => expect(openEntryStoreMock).toHaveBeenCalled());

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("syncs once the store resolves, when a Server URL is configured", async () => {
    const store = createFakeStore();
    openEntryStoreMock.mockResolvedValue({
      store,
      taskStore: createFakeTaskStore(),
      deviceId: "device-a",
    });
    useSettingsStore.getState().setServerUrl("https://server.example");

    await renderSyncLoop();

    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ store, deviceId: "device-a" }));
    expect(syncMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskStore: expect.anything() }),
    );
  });

  // ADR 0011: sync is opt-in. The gate is checked live, at the moment of
  // this first attempt — no need to wait out further poll intervals to
  // prove it never fires.
  it("does not sync once the store resolves, with no Server URL configured", async () => {
    openEntryStoreMock.mockResolvedValue({
      store: createFakeStore(),
      taskStore: createFakeTaskStore(),
      deviceId: "device-a",
    });

    await renderSyncLoop();
    await waitFor(() => expect(openEntryStoreMock).toHaveBeenCalled());
    // Give the (would-be) first attempt a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("does not sync once the store resolves, while the app is hidden", async () => {
    openEntryStoreMock.mockResolvedValue({
      store: createFakeStore(),
      taskStore: createFakeTaskStore(),
      deviceId: "device-a",
    });
    useSettingsStore.getState().setServerUrl("https://server.example");
    isTabVisibleMock.mockReturnValue(false);

    await renderSyncLoop();
    await waitFor(() => expect(openEntryStoreMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("subscribes to wake events once, and syncs again right away on a wake signal", async () => {
    const store = createFakeStore();
    openEntryStoreMock.mockResolvedValue({
      store,
      taskStore: createFakeTaskStore(),
      deviceId: "device-a",
    });
    useSettingsStore.getState().setServerUrl("https://server.example");

    await renderSyncLoop();
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    expect(subscribeToWakeEventsMock).toHaveBeenCalledTimes(1);
    const wake = subscribeToWakeEventsMock.mock.calls[0]?.[0];

    wake?.();

    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(2));
  });

  // wake-signals.web.ts's "online"/"focus" listeners can fire while the tab
  // is genuinely hidden (a backgrounded tab regaining network) — a wake
  // signal alone doesn't guarantee the app is actually foregrounded.
  it("does not sync on a wake signal that arrives while the app is hidden", async () => {
    const store = createFakeStore();
    openEntryStoreMock.mockResolvedValue({
      store,
      taskStore: createFakeTaskStore(),
      deviceId: "device-a",
    });
    useSettingsStore.getState().setServerUrl("https://server.example");

    await renderSyncLoop();
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    const wake = subscribeToWakeEventsMock.mock.calls[0]?.[0];
    isTabVisibleMock.mockReturnValue(false);

    wake?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  // Regression coverage for the coalescing bug ticket 38 hit in e2e: a wake
  // signal that arrives while the first sync is still in flight must not be
  // silently folded into that stale run (which already read the store's
  // pending Entries before whatever prompted this wake existed) — see
  // lib/sync-runner.test.ts for the focused version of this behaviour.
  it("runs sync again for a wake signal that arrives mid-flight, rather than dropping it", async () => {
    const store = createFakeStore();
    openEntryStoreMock.mockResolvedValue({
      store,
      taskStore: createFakeTaskStore(),
      deviceId: "device-a",
    });
    useSettingsStore.getState().setServerUrl("https://server.example");
    let resolveSync: () => void = () => {};
    syncMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
    );

    await renderSyncLoop();
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    const wake = subscribeToWakeEventsMock.mock.calls[0]?.[0];

    wake?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncMock).toHaveBeenCalledTimes(1);

    resolveSync();
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(2));
  });

  describe("polling cadence", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls again on the interval while visible", async () => {
      const store = createFakeStore();
      openEntryStoreMock.mockResolvedValue({
        store,
        taskStore: createFakeTaskStore(),
        deviceId: "device-a",
      });
      useSettingsStore.getState().setServerUrl("https://server.example");

      await renderSyncLoop();
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(syncMock).toHaveBeenCalledTimes(1);

      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(syncMock).toHaveBeenCalledTimes(2);

      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(syncMock).toHaveBeenCalledTimes(3);
    });

    it("never syncs across several poll intervals with no Server URL configured", async () => {
      openEntryStoreMock.mockResolvedValue({
        store: createFakeStore(),
        taskStore: createFakeTaskStore(),
        deviceId: "device-a",
      });

      await renderSyncLoop();
      await act(() => vi.advanceTimersByTimeAsync(20_000));

      expect(syncMock).not.toHaveBeenCalled();
    });
  });
});
