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
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    applyPulled: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    setColour: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
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

  // Issue #229's own gap: LabelStore.rename/setColour/remove existed
  // since #170 but were "wired to no UI at all" (this file's own header
  // comment, pre-#229) — these prove the mutation surface itself, not the
  // store mechanism (label-store-contract.ts already covers that).
  describe("management (issue #229)", () => {
    it("addLabel creates a Label from plain text, coloured the given colour", async () => {
      const store = createFakeStore();
      const { result } = await renderUseLabels(store);

      act(() => result.current.addLabel("Errands", "#DC4C3E"));

      await waitFor(() => expect(result.current.labels).toHaveLength(1));
      expect(result.current.labels[0]).toMatchObject({ name: "Errands", colour: "#DC4C3E" });
    });

    it("addLabel defaults to the neutral colour when none is given", async () => {
      const store = createFakeStore();
      const { result } = await renderUseLabels(store);

      act(() => result.current.addLabel("Errands"));

      await waitFor(() => expect(result.current.labels).toHaveLength(1));
      expect(result.current.labels[0]?.colour).toBe("#808080");
    });

    it("ignores a blank Label name without touching the store", async () => {
      const store = createFakeStore();
      const { result } = await renderUseLabels(store);

      act(() => result.current.addLabel("   "));

      expect(store.upsert).not.toHaveBeenCalled();
    });

    it("renameLabel reaches LabelStore.rename, trimmed", async () => {
      const store = createFakeStore();
      await store.upsert([label({ id: "l1" })]);
      const { result } = await renderUseLabels(store);
      await waitFor(() => expect(result.current.labels).toHaveLength(1));

      act(() => result.current.renameLabel("l1", "  Home  "));

      await waitFor(() => expect(store.rename).toHaveBeenCalledWith("l1", "Home"));
    });

    it("ignores a blank rename without touching the store", async () => {
      const store = createFakeStore();
      const { result } = await renderUseLabels(store);

      act(() => result.current.renameLabel("l1", "   "));

      expect(store.rename).not.toHaveBeenCalled();
    });

    it("setLabelColour reaches LabelStore.setColour", async () => {
      const store = createFakeStore();
      const { result } = await renderUseLabels(store);

      act(() => result.current.setLabelColour("l1", "#369307"));

      await waitFor(() => expect(store.setColour).toHaveBeenCalledWith("l1", "#369307"));
    });

    it("removeLabel reaches LabelStore.remove", async () => {
      const store = createFakeStore();
      const { result } = await renderUseLabels(store);

      act(() => result.current.removeLabel("l1"));

      await waitFor(() => expect(store.remove).toHaveBeenCalledWith("l1"));
    });
  });
});
