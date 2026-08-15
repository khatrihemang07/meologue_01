import type { Entry, EntryStore } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type {
  ensureContinuousSync as EnsureContinuousSync,
  useHistory as UseHistory,
} from "./use-history";

const { syncMock, startContinuousSyncMock } = vi.hoisted(() => ({
  syncMock: vi.fn(async () => {}),
  startContinuousSyncMock: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("@meologue/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meologue/core")>();
  return { ...actual, sync: syncMock, startContinuousSync: startContinuousSyncMock };
});

// use-history.ts keeps its sync loop and in-flight coalescing at module
// scope by design (ADR superseding 0009) — each test needs a fresh module
// registry, and a fresh query-client singleton alongside it, or state from
// one test (e.g. `continuousSyncStarted`) would leak into the next.
async function importFresh() {
  vi.resetModules();
  const [hook, client] = await Promise.all([import("./use-history"), import("@/lib/query-client")]);
  return { ...hook, ...client };
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
  };
}

describe("useHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    syncMock.mockClear();
    startContinuousSyncMock.mockClear();
  });

  async function renderUseHistory(store: EntryStore, deviceId = "device-a") {
    const fresh = await importFresh();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook<ReturnType<typeof UseHistory>, void>(
      () => (fresh.useHistory as typeof UseHistory)(store, deviceId),
      { wrapper },
    );
    return { fresh, ...rendered };
  }

  it("reads entries from the store", async () => {
    const store = createFakeStore();
    await store.upsert([
      { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: null, syncedAt: null },
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

  it("triggers a sync after Sending only when a Server URL is configured", async () => {
    const store = createFakeStore();
    const { result } = await renderUseHistory(store);
    await waitFor(() => expect(result.current.entries).toEqual([]));

    act(() => result.current.sendEntry("no sync yet"));
    await waitFor(() => expect(store.upsert).toHaveBeenCalled());

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("refreshes entries again once a Sync triggered by Send completes", async () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");
    const store = createFakeStore();
    const { result } = await renderUseHistory(store);
    await waitFor(() => expect(result.current.entries).toEqual([]));
    const listCallsBeforeSend = (store.list as ReturnType<typeof vi.fn>).mock.calls.length;

    act(() => result.current.sendEntry("hello"));

    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ store, deviceId: "device-a" }));
    // One refetch for the local write, a second once sync's own
    // invalidation lands — proves sync invalidates the cache rather than
    // the mutation's own refetch being the only trigger.
    await waitFor(() =>
      expect((store.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(
        listCallsBeforeSend + 2,
      ),
    );
  });
});

describe("ensureContinuousSync", () => {
  beforeEach(() => {
    localStorage.clear();
    startContinuousSyncMock.mockClear();
  });

  it("starts the continuous sync loop at most once per module load", async () => {
    const fresh = await importFresh();
    const store = createFakeStore();
    const ensure = fresh.ensureContinuousSync as typeof EnsureContinuousSync;

    ensure(store, "device-a");
    ensure(store, "device-a");

    expect(startContinuousSyncMock).toHaveBeenCalledTimes(1);
  });
});
