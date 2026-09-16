import type { Comment, CommentStore, Event, EventStore, Task, TaskStore } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useComments as UseComments } from "./use-comments";

// use-comments.ts reaches for the `queryClient` singleton exported by
// lib/query-client.ts directly (not React context) — the same shape
// use-history.test.tsx's own comment explains — so each test needs a
// fresh module registry, or a query cached by one test would leak into
// the next.
async function importFresh() {
  vi.resetModules();
  const [hook, client] = await Promise.all([
    import("./use-comments"),
    import("@/lib/query-client"),
  ]);
  return { ...hook, ...client };
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    deviceId: "device-a",
    taskId: "t1",
    text: "sounds good",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    deviceId: "device-a",
    content: "Buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    date: null,
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

function createFakeCommentStore(seed: Comment[] = []): CommentStore {
  let comments: Comment[] = seed;
  return {
    list: vi.fn(async () => comments),
    listByTask: vi.fn(async (taskId: string) => comments.filter((c) => c.taskId === taskId)),
    search: vi.fn(async () => []),
    get: vi.fn(async (id: string) => comments.find((c) => c.id === id)),
    upsert: vi.fn(async (incoming: Comment[]) => {
      comments = [...comments, ...incoming];
    }),
    applyPulled: vi.fn(async () => {}),
    applyAcknowledged: vi.fn(async () => {}),
    edit: vi.fn(async (id: string, text: string) => {
      comments = comments.map((c) => (c.id === id ? { ...c, text, seq: null } : c));
    }),
    remove: vi.fn(async (id: string) => {
      comments = comments.map((c) =>
        c.id === id ? { ...c, text: "", deletedAt: new Date().toISOString() } : c,
      );
    }),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    catchUpRowShapeEpoch: vi.fn(async () => {}),
  };
}

function createFakeTaskStore(tasks: Task[] = [task()]): TaskStore {
  return {
    get: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
  } as unknown as TaskStore;
}

// Mirrors use-tasks.test.tsx's own `fakeEventStore` — a working stub
// (`record` actually appends), since these tests assert directly on what
// it was, and wasn't, called with.
function createFakeEventStore(): EventStore {
  const events: Event[] = [];
  return {
    list: vi.fn(async () => events),
    listByTask: vi.fn(async (taskId: string) => events.filter((e) => e.taskId === taskId)),
    listByProject: vi.fn(async () => []),
    record: vi.fn(async (event: Event) => {
      events.push(event);
    }),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    catchUpRowShapeEpoch: vi.fn(async () => {}),
  } as unknown as EventStore;
}

describe("useComments", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function renderUseComments(
    commentStore: CommentStore,
    taskStore: TaskStore = createFakeTaskStore(),
    eventStore: EventStore = createFakeEventStore(),
    deviceId = "device-a",
  ) {
    const fresh = await importFresh();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={fresh.queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook<ReturnType<typeof UseComments>, void>(
      () =>
        (fresh.useComments as typeof UseComments)(commentStore, taskStore, eventStore, deviceId),
      { wrapper },
    );
    return { fresh, eventStore, ...rendered };
  }

  // CMT-06, re-driven live (flow 5): Todoist's own activity log records no
  // Event at all for a comment edit — this is the fix at the source
  // use-comments.ts's own header comment now describes: `editComment` no
  // longer calls `recordCommentEvent`.
  it("records no Event when a Comment is edited", async () => {
    const store = createFakeCommentStore([comment()]);
    const { result, eventStore } = await renderUseComments(store);

    await act(async () => {
      result.current.editComment("c1", "sounds better now");
    });

    await waitFor(() => expect(store.edit).toHaveBeenCalledWith("c1", "sounds better now"));
    expect(eventStore.record).not.toHaveBeenCalled();
  });

  // The two templates CMT-06 confirms Todoist *does* record, unchanged by
  // this fix — only the edit path stopped recording.
  it("still records an Event when a Comment is added", async () => {
    const store = createFakeCommentStore([]);
    const { result, eventStore } = await renderUseComments(store);

    await act(async () => {
      result.current.addComment("t1", "sounds good");
    });

    await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
    expect(eventStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "added", objectType: "comment" }),
    );
  });

  it("still records an Event when a Comment is deleted", async () => {
    const store = createFakeCommentStore([comment()]);
    const { result, eventStore } = await renderUseComments(store);

    await act(async () => {
      result.current.removeComment("c1");
    });

    await waitFor(() => expect(eventStore.record).toHaveBeenCalledTimes(1));
    expect(eventStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "deleted", objectType: "comment" }),
    );
  });
});
