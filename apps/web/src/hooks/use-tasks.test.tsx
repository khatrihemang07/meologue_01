import type {
  CommentStore,
  Entry,
  EntryStore,
  LabelStore,
  ProjectStore,
  Task,
  TaskStore,
} from "@meologue/core";
import { nextOccurrence, tomorrowOf } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useTasks as UseTasks } from "./use-tasks";

// Issue #177: `afterLocalWrite`'s own nudge, mocked the identical way
// use-history.test.tsx's own `requestSyncMock` is (that file's own comment
// explains why `vi.mock` rather than spying on the real thing — sync-runner
// keeps module-scope in-flight state that a real call would need a live
// Server to resolve).
const { requestSyncMock } = vi.hoisted(() => ({
  requestSyncMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/sync-runner", () => ({ requestSync: requestSyncMock }));

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
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    // Undated, no deadline, priority 1 ("no priority") — the
    // same default packages/core/src/test-support/task-fixture.ts uses.
    date: null,
    deadline: null,
    priority: 1,
    // No Labels, doesn't repeat — the same "concrete value, not a gap"
    // default packages/core/src/test-support/task-fixture.ts's own
    // fixture uses for these two issue #170 fields.
    labelIds: [],
    dateString: null,
    // In Inbox, no Section, top-level — the same "nothing chosen yet"
    // state every other #171 field above defaults to, and what a Task
    // created directly in Todo starts with (@meologue/core's task-types.ts).
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

function createFakeStore(): TaskStore {
  let active: Task[] = [];
  let completed: Task[] = [];
  return {
    list: vi.fn(async () => active),
    // Issue #171's four structural queries — this fake never needs to
    // observe them either (no test here exercises Project/Section/
    // sub-task scoping; that lives in todo-page.test.tsx and
    // packages/core's own contract suite), so each is just the same
    // filter its real SqliteTaskStore/InMemoryTaskStore sibling applies,
    // enough to satisfy the TaskStore interface.
    listByProject: vi.fn(async (projectId: string | null) =>
      active.filter((t) => t.parentId === null && t.projectId === projectId),
    ),
    listChildren: vi.fn(async (parentId: string) => active.filter((t) => t.parentId === parentId)),
    listInSection: vi.fn(async (sectionId: string) =>
      [...active, ...completed].filter((t) => t.sectionId === sectionId),
    ),
    listDescendants: vi.fn(async (id: string) => {
      const all = [...active, ...completed];
      const descendants: Task[] = [];
      let frontier = [id];
      while (frontier.length > 0) {
        const children = all.filter((t) => t.parentId !== null && frontier.includes(t.parentId));
        descendants.push(...children);
        frontier = children.map((t) => t.id);
      }
      return descendants;
    }),
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
    reorderToday: vi.fn(async (id: string, dayOrder: string) => {
      active = active.map((t) => (t.id === id ? { ...t, dayOrder, seq: null } : t));
    }),
    remove: vi.fn(async (id: string) => {
      active = active.filter((t) => t.id !== id);
    }),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    // Issue #169's three setters — this fake never needs to observe their
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
    setPriority: vi.fn(async (id: string, priority: number) => {
      active = active.map((t) => (t.id === id ? { ...t, priority, seq: null } : t));
    }),
    setLabelIds: vi.fn(async (id: string, labelIds: string[]) => {
      active = active.map((t) => (t.id === id ? { ...t, labelIds, seq: null } : t));
    }),
    // Issue #170's three recurrence methods — mirrored closely enough
    // against packages/core's own SqliteTaskStore/InMemoryTaskStore
    // mechanics (../../packages/core/src/sqlite/sqlite-task-store.ts) that
    // this suite's own recurrence tests below exercise real behaviour
    // rather than a stub that always no-ops.
    advanceRecurring: vi.fn(async (id: string, completedAt: string) => {
      const found = active.find((t) => t.id === id);
      if (found === undefined || found.dateString === null) return;
      const outcome = nextOccurrence(found.dateString, {
        dueDate: found.date,
        now: completedAt.slice(0, 10),
      });
      if (outcome.kind === "occurrence") {
        active = active.map((t) => (t.id === id ? { ...t, date: outcome.date, seq: null } : t));
        return;
      }
      // "refused" or "ended" both file the Task as an ordinary completed
      // one — the same fallback advanceRecurring's own doc comment
      // (task-store.ts) gives for a bounded rule that has run out.
      active = active.filter((t) => t.id !== id);
      completed = [{ ...found, completedAt, dateString: null, seq: null }, ...completed];
    }),
    completeForever: vi.fn(async (id: string, completedAt: string) => {
      const found = active.find((t) => t.id === id);
      if (!found) return;
      active = active.filter((t) => t.id !== id);
      completed = [{ ...found, completedAt, dateString: null, seq: null }, ...completed];
    }),
    postpone: vi.fn(async (id: string, today: string) => {
      active = active.map((t) =>
        t.id === id && t.date !== null ? { ...t, date: tomorrowOf(today), seq: null } : t,
      );
    }),
    // Issue #171's three structural setters — mirrored loosely rather
    // than replicating the real stores' own cycle/depth-cap validation
    // (packages/core/src/task-store-contract.ts already proves that): this
    // fake only needs to make the write visible to a caller that reads
    // `active` back afterwards.
    setProject: vi.fn(async (id: string, projectId: string | null) => {
      active = active.map((t) =>
        t.id === id ? { ...t, projectId, sectionId: null, seq: null } : t,
      );
    }),
    setSection: vi.fn(async (id: string, sectionId: string | null) => {
      active = active.map((t) => (t.id === id ? { ...t, sectionId, seq: null } : t));
    }),
    setParent: vi.fn(async (id: string, parentId: string | null) => {
      active = active.map((t) => (t.id === id ? { ...t, parentId, seq: null } : t));
    }),
    setDescription: vi.fn(async (id: string, description: string | null) => {
      active = active.map((t) => (t.id === id ? { ...t, description, seq: null } : t));
    }),
  };
}

/**
 * A minimal, in-memory `EntryStore` stand-in — `useTasks`' own fan-out
 * (issue #173, ADR 0048) reads and writes Entries through this rather than
 * through TaskStore, so every test in this suite that doesn't care about
 * Entries at all gets one with nothing in it (`renderUseTasks`'s own
 * default), and the fan-out tests further down construct one seeded with
 * an Entry carrying a `[[task:id|label]]` Reference.
 *
 * `search` is a plain substring match against the raw body rather than the
 * real FTS5 tokenizer `sqlite-entry-store.ts` runs — good enough here
 * because the only query this module ever issues is the bare Task uuid
 * itself (`task-reference-sync.ts`'s own module comment explains why that
 * always finds a real mark against the real index); the real tokenizer
 * behaviour is exercised by `task-reference-sync.test.ts` instead, against
 * a real search.
 */
function createFakeEntryStore(initial: readonly Entry[] = []): EntryStore {
  let entries = [...initial];
  return {
    list: vi.fn(async () => entries),
    upsert: vi.fn(async (incoming: Entry[]) => {
      entries = [...entries, ...incoming];
    }),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    search: vi.fn(async (query: string) => entries.filter((e) => e.body.includes(query))),
    edit: vi.fn(async (id: string, body: string) => {
      entries = entries.map((e) => (e.id === id ? { ...e, body, seq: null } : e));
    }),
    remove: vi.fn(async (id: string) => {
      entries = entries.map((e) =>
        e.id === id ? { ...e, body: "", deletedAt: new Date().toISOString() } : e,
      );
    }),
    getMany: vi.fn(async (ids: string[]) => entries.filter((e) => ids.includes(e.id))),
  };
}

describe("useTasks", () => {
  beforeEach(() => {
    localStorage.clear();
    requestSyncMock.mockClear();
  });

  async function renderUseTasks(
    store: TaskStore,
    entryStore: EntryStore = createFakeEntryStore(),
    deviceId = "device-a",
  ) {
    const fresh = await importFresh();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    // Issue #182: `useTasks` now takes three more stores solely to pass
    // through to `requestSync` (use-tasks.ts's own doc comment) — this
    // suite mocks `requestSync` wholesale (`requestSyncMock` above), so
    // none of the three is ever actually called; a bare cast is enough to
    // satisfy the parameter's type without a full fake implementation.
    const projectStore = {} as ProjectStore;
    const labelStore = {} as LabelStore;
    const commentStore = {} as CommentStore;
    const rendered = renderHook<ReturnType<typeof UseTasks>, void>(
      () =>
        (fresh.useTasks as typeof UseTasks)(
          entryStore,
          store,
          projectStore,
          labelStore,
          commentStore,
          deviceId,
        ),
      { wrapper },
    );
    return { fresh, entryStore, ...rendered };
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
      // starts undated, with no deadline, and priority 1
      // ("no priority") — asserted explicitly here rather than trusted,
      // since addTask states this as a decision at its own call site.
      expect.objectContaining({
        content: "call mum",
        deviceId: "device-a",
        completedAt: null,
        date: null,
        deadline: null,
        priority: 1,
      }),
    ]);
    const added = result.current.tasks.find((t) => t.content === "call mum");
    expect(added).toBeDefined();
    expect((added as Task).orderKey > "M").toBe(true);
  });

  // Issue #177: `afterLocalWrite`'s own nudge — before this fix, a Task
  // mutation refreshed the local TanStack Query cache but never called
  // `requestSync`, so a Task created, completed or edited here reached
  // another Device only at the next scheduled poll rather than
  // immediately, unlike every Entry mutation (use-history.ts's own
  // `afterLocalWrite`) and the Tasks backfill (backfill-tasks.ts), both of
  // which already nudge.
  it("nudges Sync right away after adding a Task, rather than waiting for the next poll", async () => {
    const store = createFakeStore();
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toEqual([]));

    act(() => result.current.addTask("call mum"));

    await waitFor(() =>
      expect(requestSyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ taskStore: store }),
        "device-a",
      ),
    );
  });

  it("nudges Sync right away after completing a Task", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a" })]);
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    requestSyncMock.mockClear();

    act(() => result.current.completeTask("a"));

    await waitFor(() =>
      expect(requestSyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ taskStore: store }),
        "device-a",
      ),
    );
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

  // Issue #178: setTaskLabels is this hook's own door onto
  // TaskStore.setLabelIds — the first UI caller of a mutation this hook
  // already exposed (this ticket's own report names the gap).
  it("setTaskLabels writes the whole replacement array through setLabelIds", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a", labelIds: ["l1"] })]);
    const { result } = await renderUseTasks(store);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.setTaskLabels("a", ["l1", "l2"]));

    await waitFor(() => expect(store.setLabelIds).toHaveBeenCalledWith("a", ["l1", "l2"]));
  });

  // ADR 0048's fan-out: an act on the Task side refreshes every Entry
  // referencing it. `entry()` mirrors entry-row.test.tsx's own fixture
  // shape.
  function entry(overrides: Partial<Entry>): Entry {
    return {
      id: "e1",
      deviceId: "device-a",
      body: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      ...overrides,
    };
  }

  describe("the Task-side half of ADR 0048's cache refresh", () => {
    // A real uuid — `parseReferenceTask`'s own `TASK_SHAPE` (inline-
    // markdown.ts) refuses anything shorter, so this suite's usual
    // single-letter Task ids ("a", "b") would never parse back into a real
    // `taskReference` node at all.
    const TASK_ID = "0192abcd-1234-7890-abcd-0123456789ac";

    it("renaming a Task refreshes the cached label in every Entry referencing it", async () => {
      const store = createFakeStore();
      await store.upsert([task({ id: TASK_ID, content: "old label" })]);
      const { formatTaskReference } = await import("@/lib/inline-markdown");
      const referencing = entry({
        id: "e1",
        body: `- [ ] ${formatTaskReference(TASK_ID, "old label")}`,
      });
      const entryStore = createFakeEntryStore([referencing]);
      const { result } = await renderUseTasks(store, entryStore);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));

      act(() => result.current.renameTask(TASK_ID, "new label"));

      await waitFor(() =>
        expect(entryStore.edit).toHaveBeenCalledWith(
          "e1",
          `- [ ] ${formatTaskReference(TASK_ID, "new label")}`,
        ),
      );
    });

    it("completing a Task from Todo ticks the cached marker in every Entry referencing it", async () => {
      const store = createFakeStore();
      await store.upsert([task({ id: TASK_ID, content: "buy milk" })]);
      const { formatTaskReference } = await import("@/lib/inline-markdown");
      const referencing = entry({
        id: "e1",
        body: `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
      });
      const entryStore = createFakeEntryStore([referencing]);
      const { result } = await renderUseTasks(store, entryStore);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));

      act(() => result.current.completeTask(TASK_ID));

      await waitFor(() =>
        expect(entryStore.edit).toHaveBeenCalledWith(
          "e1",
          `- [x] ${formatTaskReference(TASK_ID, "buy milk")}`,
        ),
      );
    });

    it("uncompleting a Task from Todo unticks the cached marker in every Entry referencing it", async () => {
      const store = createFakeStore();
      await store.upsert([task({ id: TASK_ID, content: "buy milk" })]);
      await store.complete(TASK_ID, "2026-01-02T00:00:00.000Z");
      const { formatTaskReference } = await import("@/lib/inline-markdown");
      const referencing = entry({
        id: "e1",
        body: `- [x] ${formatTaskReference(TASK_ID, "buy milk")}`,
      });
      const entryStore = createFakeEntryStore([referencing]);
      const { result } = await renderUseTasks(store, entryStore);
      await waitFor(() => expect(result.current.completedTasks).toHaveLength(1));

      act(() => result.current.uncompleteTask(TASK_ID));

      await waitFor(() =>
        expect(entryStore.edit).toHaveBeenCalledWith(
          "e1",
          `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`,
        ),
      );
    });

    it("does not write to any Entry when the Task has no Reference to refresh", async () => {
      const store = createFakeStore();
      await store.upsert([task({ id: TASK_ID, content: "buy milk" })]);
      const entryStore = createFakeEntryStore([]);
      const { result } = await renderUseTasks(store, entryStore);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));

      act(() => result.current.completeTask(TASK_ID));

      await waitFor(() => expect(result.current.completedTasks).toHaveLength(1));
      expect(entryStore.edit).not.toHaveBeenCalled();
    });
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

  // ADR 0048's asymmetric deletion, proven at the write path rather than
  // merely inferred from the diff: deleting a Task must never reach across
  // into the Entry store at all — not a search to find a referencing
  // Entry, not an edit to its body. The Entry's own line is left exactly
  // as it was, as the plain text of its last cached label (entry-row.tsx's
  // own render-level test, entry-bubble.test.tsx, proves that half; this
  // proves the Task-side write never even attempts the other half).
  it("never touches the Entry store when removing a Task — deletion is asymmetric (ADR 0048)", async () => {
    const store = createFakeStore();
    await store.upsert([task({ id: "a" })]);
    const entryStore = createFakeEntryStore();
    const { result } = await renderUseTasks(store, entryStore);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.removeTask("a"));

    await waitFor(() => expect(store.remove).toHaveBeenCalledWith("a"));
    expect(entryStore.search).not.toHaveBeenCalled();
    expect(entryStore.edit).not.toHaveBeenCalled();
    expect(entryStore.upsert).not.toHaveBeenCalled();
    expect(entryStore.remove).not.toHaveBeenCalled();
  });

  it("adds a Task carrying overrides — labelIds and dateString among them", async () => {
    const store = createFakeStore();
    const { result } = await renderUseTasks(store);

    act(() =>
      result.current.addTask("pay rent", {
        date: "2026-09-05",
        deadline: "2026-09-10",
        priority: 4,
        labelIds: ["label-1"],
        dateString: "every month",
      }),
    );

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    const added = result.current.tasks[0];
    expect(added).toMatchObject({
      content: "pay rent",
      date: "2026-09-05",
      deadline: "2026-09-10",
      priority: 4,
      labelIds: ["label-1"],
      dateString: "every month",
    });
  });

  it("omitted overrides default to the same undated, un-repeating state a bare addTask always has", async () => {
    const store = createFakeStore();
    const { result } = await renderUseTasks(store);

    act(() => result.current.addTask("call mum"));

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.tasks[0]).toMatchObject({
      date: null,
      deadline: null,
      priority: 1,
      labelIds: [],
      dateString: null,
    });
  });

  describe("recurrence", () => {
    it("advanceRecurringTask moves a recurring Task's date forward without completing it", async () => {
      const store = createFakeStore();
      await store.upsert([task({ id: "a", date: "2026-01-01", dateString: "every month" })]);
      const { result } = await renderUseTasks(store);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));

      act(() => result.current.advanceRecurringTask("a"));

      await waitFor(() =>
        expect(store.advanceRecurring).toHaveBeenCalledWith("a", expect.any(String)),
      );
      // Never enters completedTasks — TaskStore.advanceRecurring's own
      // doc comment: "the checkbox does not un-tick itself."
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));
      expect(result.current.completedTasks).toEqual([]);
      expect(result.current.tasks[0]?.date).not.toBe("2026-01-01");
    });

    it("completeForeverTask ends the series and files it as an ordinary completed Task", async () => {
      const store = createFakeStore();
      await store.upsert([
        task({ id: "a", content: "pay rent", date: "2026-09-01", dateString: "every month" }),
      ]);
      const { result } = await renderUseTasks(store);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));

      act(() => result.current.completeForeverTask("a"));

      await waitFor(() => expect(result.current.tasks).toEqual([]));
      await waitFor(() => expect(result.current.completedTasks).toHaveLength(1));
      expect(result.current.completedTasks[0]).toMatchObject({
        content: "pay rent",
        dateString: null,
      });
    });

    it("postponeTask moves an overdue Task's date to tomorrow", async () => {
      const store = createFakeStore();
      await store.upsert([task({ id: "a", date: "2020-01-01" })]);
      const { result } = await renderUseTasks(store);
      await waitFor(() => expect(result.current.tasks).toHaveLength(1));

      act(() => result.current.postponeTask("a"));

      await waitFor(() => expect(store.postpone).toHaveBeenCalledWith("a", expect.any(String)));
      await waitFor(() => expect(result.current.tasks[0]?.date).not.toBe("2020-01-01"));
    });
  });
});
