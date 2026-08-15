import type { EntryStore } from "@meologue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  return import("./sync-runner");
}

function createFakeStore(): EntryStore {
  return {
    list: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  };
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

    await requestSync(store, "device-a");

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(expect.objectContaining({ store, deviceId: "device-a" }));
  });

  it("does nothing with no Server URL configured (ADR 0011)", async () => {
    useSettingsStore.getState().setServerUrl("");
    const { requestSync } = await importFresh();
    const store = createFakeStore();

    await requestSync(store, "device-a");

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent callers into a single in-flight sync", async () => {
    const { requestSync } = await importFresh();
    const store = createFakeStore();
    let resolveSync: () => void = () => {};
    syncMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
    );

    const first = requestSync(store, "device-a");
    const second = requestSync(store, "device-a");
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
    let resolveFirst: () => void = () => {};
    syncMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const first = requestSync(store, "device-a");
    expect(syncMock).toHaveBeenCalledTimes(1);

    // Arrives while the first run is still in flight.
    const second = requestSync(store, "device-a");
    resolveFirst();
    await Promise.all([first, second]);

    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  it("never runs two syncs concurrently, even across a mid-flight rerun", async () => {
    const { requestSync } = await importFresh();
    const store = createFakeStore();
    let concurrent = 0;
    let maxConcurrent = 0;
    syncMock.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      concurrent--;
    });

    const first = requestSync(store, "device-a");
    const second = requestSync(store, "device-a");
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(syncMock).toHaveBeenCalledTimes(2);
  });
});
