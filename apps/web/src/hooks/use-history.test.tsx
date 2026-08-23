import type { Entry, EntryStore } from "@meologue/core";
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
  };
}

describe("useHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    requestSyncMock.mockClear();
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

    await waitFor(() => expect(requestSyncMock).toHaveBeenCalledWith(store, "device-a"));
  });

  describe("editEntry (ADR 0028)", () => {
    it("changes the Entry's body through the store and pushes the change", async () => {
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.editEntry("1", "an edited body"));

      await waitFor(() => expect(store.edit).toHaveBeenCalledWith("1", "an edited body"));
      await waitFor(() => expect(requestSyncMock).toHaveBeenCalledWith(store, "device-a"));
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
      await waitFor(() => expect(requestSyncMock).toHaveBeenCalledWith(store, "device-a"));
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
});
