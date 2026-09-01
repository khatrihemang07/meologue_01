import type { Task, TaskStore } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useTasks as UseTasks } from "./use-tasks";

// use-tasks.ts reaches for the `queryClient` singleton exported by
// lib/query-client.ts directly (not React context), the same shape
// use-history.test.tsx's own comment explains — each test needs a fresh
// module registry, or a query cached by one test would leak into the next.
async function importFresh() {
  vi.resetModules();
  const [hook, client] = await Promise.all([import("./use-tasks"), import("@/lib/query-client")]);
  return { ...hook, ...client };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    // Undated, no deadline, no duration, priority 1 ("no priority") — the
    // same default packages/core/src/test-support/task-fixture.ts uses.
    date: null,
    deadline: null,
    duration: null,
    priority: 1,
    ...overrides,
  };
}

function createFakeStore(): TaskStore {
  let active: Task[] = [];
  let completed: Task[] = [];
  return {
    list: vi.fn(async () => active),
    listCompleted: vi.fn(async () => completed),
    get: vi.fn(async (id: string) => active.find((t) => t.id === id)),
    upsert: vi.fn(async (incoming: Task[]) => {
      active = [...active, ...incoming];
    }),
    complete: vi.fn(async (id: string, completedAt: string) => {
      const found = active.find((t) => t.id === id);
      if (!found) return;
      active = active.filter((t) => t.id !== id);
      completed = [{ ...found, completedAt, seq: null }, ...completed];
    }),
    uncomplete: vi.fn(async (id: string) => {
      const found = completed.find((t) => t.id === id);
      if (!found) return;
      completed = completed.filter((t) => t.id !== id);
      active = [...active, { ...found, completedAt: null, seq: null }];
    }),
    rename: vi.fn(async (id: string, content: string) => {
      active = active.map((t) => (t.id === id ? { ...t, content, seq: null } : t));
    }),
    reorder: vi.fn(async (id: string, orderKey: string) => {
      active = active.map((t) => (t.id === id ? { ...t, orderKey, seq: null } : t));
    }),
    remove: vi.fn(async (id: string) => {
      active = active.filter((t) => t.id !== id);
    }),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    // Issue #169's four setters — this fake never needs to observe their
    // effect (no test here exercises the picker path; that lives in
    // task-row.test.tsx and today-view.test.tsx), so each just mutates
    // `active` the same shape complete()/uncomplete() above do, enough to
    // satisfy the TaskStore interface without a caller ever inspecting it.
    setDate: vi.fn(async (id: string, date: string | null) => {
      active = active.map((t) => (t.id === id ? { ...t, date, seq: null } : t));
    }),
    setDeadline: vi.fn(async (id: string, deadline: string | null) => {
      active = active.map((t) => (t.id === id ? { ...t, deadline, seq: null } : t));
    }),
    setDuration: vi.fn(async (id: string, duration: number | null) => {
      active = active.map((t) => (t.id === id ? { ...t, duration, seq: null } : t));
    }),
    setPriority: vi.fn(async (id: string, priority: number) => {
      active = active.map((t) => (t.id === id ? { ...t, priority, seq: null } : t));
    }),
  };
}

describe("useTasks", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function renderUseTasks(store: TaskStore, deviceId = "device-a") {
    const fresh = await importFresh();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook<ReturnType<typeof UseTasks>, void>(
      () => (fresh.useTasks as typeof UseTasks)(store, deviceId),
      { wrapper },
    );
    return { fresh, ...rendered };
  }

  it("reads active Tasks from the store", async () => {
    const store = createFakeStore();
    await store.upsert([task()]);

    const { result } = await renderUseTasks(store);

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.tasks.map((t) => t.content)).toEqual(["buy milk"]);
  });

  it("ignores blank input without touching the store", async () => {
    const store = createFakeStore();
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toEqual([]));

    act(() => result.current.addTask("   "));

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("adds a Task, ordered after every existing one", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "existing", orderKey: "M" })]);
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.addTask("call mum"));

    await waitFor(() => expect(result.current.tasks).toHaveLength(2));
    expect(store.upsert).toHaveBeenLastCalledWith([
      // Issue #169's own acceptance criterion: a Task created in Todo
      // starts undated, with no deadline, no duration, and priority 1
      // ("no priority") — asserted explicitly here rather than trusted,
      // since addTask states this as a decision at its own call site.
      expect.objectContaining({
        content: "call mum",
        deviceId: "device-a",
        completedAt: null,
        date: null,
        deadline: null,
        duration: null,
        priority: 1,
      }),
    ]);
    const added = result.current.tasks.find((t) => t.content === "call mum");
    expect(added).toBeDefined();
    expect((added as Task).orderKey > "M").toBe(true);
  });

  it("completes a Task, moving it out of the active list and into completedTasks", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a" })]);
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.completeTask("a"));

    await waitFor(() => expect(result.current.tasks).toEqual([]));
    await waitFor(() => expect(result.current.completedTasks).toHaveLength(1));
    expect(store.complete).toHaveBeenCalledWith("a", expect.any(String));
  });

  it("uncompletes a Task, moving it back into the active list", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a" })]);
    await store.complete("a", "2026-01-02T00:00:00.000Z");
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.completedTasks).toHaveLength(1));

    act(() => result.current.uncompleteTask("a"));

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(store.uncomplete).toHaveBeenCalledWith("a");
  });

  it("renames a Task, trimming the same way addTask does", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a", content: "old" })]);
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.renameTask("a", "  new  "));

    await waitFor(() => expect(store.rename).toHaveBeenCalledWith("a", "new"));
  });

  it("reorders a Task by writing the exact key it's handed, and nothing else", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a", orderKey: "A" }), task({ id: "b", orderKey: "B" })]);
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toHaveLength(2));

    act(() => result.current.reorderTask("b", "AM"));

    await waitFor(() => expect(store.reorder).toHaveBeenCalledWith("b", "AM"));
    // Exactly one call, against exactly the dragged Task's id — the store
    // contract itself (packages/core's own taskStoreContract) is what
    // proves this writes one row; this only proves the hook asked for
    // exactly the one row task-reorder.ts computed, nothing more.
    expect(store.reorder).toHaveBeenCalledTimes(1);
  });

  it("removes a Task through the store by id", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a" })]);
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.removeTask("a"));

    await waitFor(() => expect(store.remove).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(result.current.tasks).toEqual([]));
  });
});
