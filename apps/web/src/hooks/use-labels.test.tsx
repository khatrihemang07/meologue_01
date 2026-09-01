import type { Label, LabelStore } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useLabels as UseLabels } from "./use-labels";

// Mirrors use-tasks.test.tsx's own `importFresh` for the identical reason
// (that file's own comment): each test needs a fresh module registry, or a
// query cached by one test leaks into the next.
async function importFresh() {
  vi.resetModules();
  const [hook, client] = await Promise.all([import("./use-labels"), import("@/lib/query-client")]);
  return { ...hook, ...client };
}

function label(overrides: Partial<Label> = {}): Label {
  return {
    id: "label-1",
    deviceId: "device-a",
    name: "Family",
    colour: "#808080",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function createFakeStore(): LabelStore {
  let active: Label[] = [];
  return {
    list: vi.fn(async () => active),
    get: vi.fn(async (id: string) => active.find((l) => l.id === id)),
    upsert: vi.fn(async (incoming: Label[]) => {
      active = [...active, ...incoming];
    }),
    rename: vi.fn(async () => {}),
    setColour: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
  };
}

describe("useLabels", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function renderUseLabels(store: LabelStore, deviceId = "device-a") {
    const fresh = await importFresh();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook<ReturnType<typeof UseLabels>, void>(
      () => (fresh.useLabels as typeof UseLabels)(store, deviceId),
      { wrapper },
    );
    return { fresh, ...rendered };
  }

  it("reads active Labels from the store", async () => {
    const store = createFakeStore();
    await store.upsert([label()]);

    const { result } = await renderUseLabels(store);

    await waitFor(() => expect(result.current.labels).toHaveLength(1));
    expect(result.current.labels[0]?.name).toBe("Family");
  });

  it("resolveLabelIds returns nothing for an empty list of names, without touching the store", async () => {
    const store = createFakeStore();
    const { result } = await renderUseLabels(store);

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.resolveLabelIds([]);
    });

    expect(ids).toEqual([]);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("resolves an existing Label by name, case-insensitively, without minting a duplicate", async () => {
    const store = createFakeStore();
    await store.upsert([label({ id: "existing", name: "Shopping" })]);
    const { result } = await renderUseLabels(store);
    await waitFor(() => expect(result.current.labels).toHaveLength(1));
    // Clears the seed call above out of the mock's history — the
    // assertion below is about what `resolveLabelIds` itself does, not
    // about this test's own arrange step.
    vi.mocked(store.upsert).mockClear();

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.resolveLabelIds(["shopping"]);
    });

    expect(ids).toEqual(["existing"]);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("mints a new Label for a name with no existing match, coloured the default", async () => {
    const store = createFakeStore();
    const { result } = await renderUseLabels(store);

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.resolveLabelIds(["Errands"]);
    });

    expect(ids).toHaveLength(1);
    expect(store.upsert).toHaveBeenCalledWith([
      expect.objectContaining({ name: "Errands", colour: "#808080", deviceId: "device-a" }),
    ]);
  });

  it("resolves two different names typed in one line to two distinct ids, in order", async () => {
    const store = createFakeStore();
    const { result } = await renderUseLabels(store);

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.resolveLabelIds(["Work", "Home"]);
    });

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("de-duplicates the same name typed twice in one line", async () => {
    const store = createFakeStore();
    const { result } = await renderUseLabels(store);

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.resolveLabelIds(["Work", "Work"]);
    });

    expect(ids).toHaveLength(1);
  });

  it("a second %label resolved in the same call reuses the Label the first one just minted", async () => {
    // The regression this guards: reading `labels` from the render that
    // triggered the call (a stale snapshot) instead of the query cache
    // fresh would create "Work" twice here instead of once.
    const store = createFakeStore();
    const { result } = await renderUseLabels(store);

    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.resolveLabelIds(["Work", "work"]);
    });

    expect(ids).toHaveLength(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
  });
});
