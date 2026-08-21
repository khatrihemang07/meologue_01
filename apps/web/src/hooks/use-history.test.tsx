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

// Undo (ADR 0028) is wired through sonner's `toast`, which needs no mounted
// `<Toaster />` to be called — but a real `<Toaster />` would only ever
// render the toast's contents into a portal, never expose its `action`
// callback in a form `fireEvent` can drive. Mocking the module and
// capturing the call's arguments directly is what lets a test invoke
// Undo's `onClick` itself, the same way `sync-runner` is mocked above.
const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMock }));

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
    toastMock.mockClear();
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

    it("offers Undo on a toast", async () => {
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      act(() => result.current.removeEntry(entry({ id: "7" })));

      expect(toastMock).toHaveBeenCalledWith(
        "Entry deleted",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
      );
    });

    it("Undo restores the Entry under a NEW id, keeping its body and createdAt", async () => {
      // The id must change. The Server's own guard — `on conflict (id) do
      // update ... where entries.deleted_at is null` — makes a delete
      // terminal for that id forever, so a restore reusing it would be
      // rejected on every push while looking fine locally: the Entry would
      // never be assigned a seq, so it would sit in pending() and re-push
      // every tick forever, diverging silently from every other Device.
      // Minting a new id turns Undo into `nothing -> A'`, which the Server
      // accepts. See use-history.ts's own comment on restoreEntryMutation.
      const store = createFakeStore();
      const { result } = await renderUseHistory(store);
      await waitFor(() => expect(result.current.entries).toEqual([]));

      const removed = entry({ id: "7", body: "don't lose me", seq: 5, syncedAt: "2026-01-01" });
      act(() => result.current.removeEntry(removed));
      await waitFor(() => expect(store.remove).toHaveBeenCalledWith("7"));

      const [, options] = toastMock.mock.calls[0] as [string, { action: { onClick: () => void } }];
      act(() => options.action.onClick());

      await waitFor(() =>
        expect(store.upsert).toHaveBeenCalledWith([
          expect.objectContaining({
            body: "don't lose me",
            createdAt: removed.createdAt,
            deletedAt: null,
            seq: null,
            syncedAt: null,
          }),
        ]),
      );
      const restoredId = vi.mocked(store.upsert).mock.calls.at(-1)?.[0]?.[0]?.id;
      expect(restoredId).toBeDefined();
      expect(restoredId).not.toBe("7");
      // store.edit() carries the same `WHERE deleted_at IS NULL` guard and
      // would no-op against the tombstone remove() just wrote, so it must
      // not be the path Undo takes either.
      expect(store.edit).not.toHaveBeenCalled();
      await waitFor(() => expect(requestSyncMock).toHaveBeenCalledWith(store, "device-a"));
    });
  });
});
