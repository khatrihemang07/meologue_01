import type {
  CommentStore,
  EntryStore,
  EventStore,
  LabelStore,
  ProjectStore,
  TaskStore,
} from "@meologue/core";
import { sync } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferCommentStoreUntilOpen,
  deferEventStoreUntilOpen,
  deferLabelStoreUntilOpen,
  deferProjectStoreUntilOpen,
  deferTaskStoreUntilOpen,
  deferUntilOpen,
  type useEntryStore as UseEntryStore,
} from "./entry-store-layout";

const { createDriver } = vi.hoisted(() => ({ createDriver: vi.fn() }));
vi.mock("@/platform/sqlite-driver", () => ({ createDriver }));

// Stubs @meologue/core's real `open` (which needs a real SqliteDriver to run
// migrations against) so the success-path test below can resolve
// openEntryStore() with a plain in-memory fake.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("@meologue/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meologue/core")>();
  return { ...actual, open: openMock };
});

// Issue #174: EntryStoreLayout kicks off the one-time backfill itself, once
// the real store opens — stubbed here so this file's tests, none of which
// care about backfill-tasks.ts's own scanning logic (backfill-tasks.test.ts
// owns that), don't each need a real EntryStore full of checkbox lines just
// to satisfy an effect this file isn't testing.
const { runTasksBackfillOnceMock } = vi.hoisted(() => ({
  runTasksBackfillOnceMock: vi.fn(async () => {}),
}));
vi.mock("@/lib/backfill-tasks", () => ({ runTasksBackfillOnce: runTasksBackfillOnceMock }));

function createFakeStore(): EntryStore {
  return {
    list: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    getMany: vi.fn(async () => []),
  };
}

// Issue #168: `open()` now resolves `{ store, taskStore, deviceId }` — every
// `openMock.mockResolvedValue` below needs a real (if empty) TaskStore
// alongside the EntryStore, or `useTasks` (called unconditionally inside
// EntryStoreLayout, the same issue #110 reasoning `useHistory` already has)
// finds nothing behind `data.taskStore` once `data` resolves.
function createFakeTaskStore(): TaskStore {
  return {
    list: vi.fn(async () => []),
    // Issue #171's four structural queries — this fake exercises none of
    // them either (see this function's own comment on the #169/#170
    // methods just below for why that's fine), but TASK_STORE_METHODS
    // type-checks against a real TaskStore, so every implementation, this
    // fake included, must carry all twenty-one.
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
    reorderToday: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    // Issue #169's four setters, and issue #170's setLabelIds plus its
    // three recurrence methods — this fake exercises none of them (this
    // file's tests only cover opening the store, not scheduling or
    // recurrence), but TASK_STORE_METHODS above type-checks against a real
    // TaskStore, so every implementation, this fake included, must carry
    // all seventeen.
    setDate: vi.fn(async () => {}),
    setDeadline: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    setLabelIds: vi.fn(async () => {}),
    advanceRecurring: vi.fn(async () => {}),
    completeForever: vi.fn(async () => {}),
    postpone: vi.fn(async () => {}),
    // Issue #171's three structural setters — same "this fake exercises
    // none of them" reasoning as setDate/etc. above.
    setProject: vi.fn(async () => {}),
    setSection: vi.fn(async () => {}),
    setParent: vi.fn(async () => {}),
    setDescription: vi.fn(async () => {}),
  };
}

// The Entry store's query is cached at module scope by design (ADR
// superseding 0009) — a Device opens its store exactly once. Each test here
// needs a fresh module registry (so the query-client singleton is a fresh
// QueryClient, with nothing cached from a previous test) and a fresh
// QueryClientProvider bound to that same singleton, or the second test would
// just observe the first test's already-settled query. All three modules
// are re-imported together so the StorageUnavailableError instance and
// entry-store-layout's own `instanceof` check come from the same fresh
// module registry.
async function importFresh() {
  vi.resetModules();
  const [layout, errors, client] = await Promise.all([
    import("./entry-store-layout"),
    import("@/lib/entry-store-errors"),
    import("@/lib/query-client"),
  ]);
  return { ...layout, ...errors, ...client };
}

// Probe is declared once at module scope, satisfying biome's
// useHookAtTopLevel (it flags a fresh function-component-per-test as a
// nested component). Which useEntryStore it calls changes every test, so it
// reads a module-level binding set by renderLayout just before rendering,
// rather than closing over one directly.
let activeUseEntryStore: typeof UseEntryStore;

function Probe() {
  const { disabled, message } = activeUseEntryStore();
  return <p>{`disabled:${disabled} message:${message ?? "none"}`}</p>;
}

// Issue #110's regression probe: records every mount/unmount of whatever
// renders under EntryStoreLayout's Outlet, so the remount test below can
// assert on it directly rather than inferring it from side effects (a
// second `GET /v1/models`, an aborted fetch) the way the original bug
// report first had to.
let mountEvents: string[] = [];

function MountProbe() {
  useEffect(() => {
    mountEvents.push("mount");
    return () => {
      mountEvents.push("unmount");
    };
  }, []);
  return <p>mounted</p>;
}

async function renderLayout() {
  const fresh = await importFresh();
  activeUseEntryStore = fresh.useEntryStore;

  render(
    <QueryClientProvider client={fresh.queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<fresh.EntryStoreLayout />}>
            <Route path="/" element={<Probe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return fresh;
}

describe("EntryStoreLayout", () => {
  beforeEach(() => {
    createDriver.mockReset();
    openMock.mockReset();
    runTasksBackfillOnceMock.mockClear();
    mountEvents = [];
  });

  it("puts a disabled, message-free context on the outlet while the store is opening", async () => {
    createDriver.mockReturnValue(new Promise(() => {}));

    await renderLayout();

    expect(screen.getByText("disabled:true message:none")).toBeInTheDocument();
  });

  it("puts a disabled context with an explicit message on the outlet once opening fails", async () => {
    const fresh = await importFresh();
    // Pre-attached so Node doesn't flag this as an unhandled rejection in
    // the window before EntryStoreLayout's own .then() catches it.
    const rejection = Promise.reject(new fresh.StorageUnavailableError());
    rejection.catch(() => {});
    createDriver.mockReturnValue(rejection);
    activeUseEntryStore = fresh.useEntryStore;

    render(
      <QueryClientProvider client={fresh.queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<fresh.EntryStoreLayout />}>
              <Route path="/" element={<Probe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "disabled:true message:meologue can't store Entries here — try a non-private window over HTTPS or localhost.",
        ),
      ).toBeInTheDocument(),
    );
  });

  // Issue #159, AC "a hung open and a rejected open are distinguishable on
  // screen": OpenTimeoutError must not read the same as StorageUnavailableError's
  // fixed sentence above — a reader whose Device is still (slowly) opening
  // the store, and one whose Device genuinely can't, are told different
  // things.
  it("puts a distinct message on the outlet when opening the store times out", async () => {
    const fresh = await importFresh();
    const rejection = Promise.reject(new fresh.OpenTimeoutError());
    rejection.catch(() => {});
    createDriver.mockReturnValue(rejection);
    activeUseEntryStore = fresh.useEntryStore;

    render(
      <QueryClientProvider client={fresh.queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<fresh.EntryStoreLayout />}>
              <Route path="/" element={<Probe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "disabled:true message:meologue is taking longer than expected to open its storage. If this doesn't resolve, try reloading.",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("renders Ready once the store opens", async () => {
    createDriver.mockResolvedValue({});
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    openMock.mockResolvedValue({ store, taskStore, deviceId: "device-a" });

    await renderLayout();

    await waitFor(() =>
      expect(screen.getByText("disabled:false message:none")).toBeInTheDocument(),
    );
  });

  // Issue #174, ADR 0053: the store-open trigger for the History backfill —
  // this pins down that EntryStoreLayout actually calls it, with the real
  // opened store/taskStore/deviceId, once and not on every re-render.
  // backfill-tasks.test.ts owns whether the backfill itself does the right
  // thing once called.
  it("kicks off the Tasks backfill exactly once, with the real opened store", async () => {
    createDriver.mockResolvedValue({});
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    // Issue #182: `runTasksBackfillOnce` now also takes the three stores
    // added alongside it (Project, Label, Comment) — bare casts suffice
    // here, mirroring use-history.test.tsx/use-tasks.test.tsx's own
    // reasoning: this test only checks they were threaded through by
    // reference, never that anything on them was actually called.
    const projectStore = {} as ProjectStore;
    const labelStore = {} as LabelStore;
    const commentStore = {} as CommentStore;
    // Issue #184: a fourth store `runTasksBackfillOnce` now threads
    // through alongside it — the identical "bare cast, only checked by
    // reference" reasoning this test's own comment above already states.
    const eventStore = {} as EventStore;
    openMock.mockResolvedValue({
      store,
      taskStore,
      projectStore,
      labelStore,
      commentStore,
      eventStore,
      deviceId: "device-a",
    });

    await renderLayout();

    await waitFor(() => expect(runTasksBackfillOnceMock).toHaveBeenCalledTimes(1));
    expect(runTasksBackfillOnceMock).toHaveBeenCalledWith(
      store,
      taskStore,
      projectStore,
      labelStore,
      commentStore,
      eventStore,
      "device-a",
      expect.any(Function),
    );
  });

  // TanStack Query's `retry: false` only governs retries within one fetch
  // attempt — a *new* observer of an already-errored query still refetches
  // on mount by default (`retryOnMount: true`). Without `retryOnMount:
  // false` on this query, this exact round trip reopens the store a second
  // time, spinning up a second Worker against the same OPFS pool lock.
  it("does not reopen the store on a Settings round trip after a failed open", async () => {
    const fresh = await importFresh();
    createDriver.mockRejectedValue(new fresh.StorageUnavailableError());
    activeUseEntryStore = fresh.useEntryStore;

    function renderOnce() {
      return render(
        <QueryClientProvider client={fresh.queryClient}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<fresh.EntryStoreLayout />}>
                <Route path="/" element={<Probe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    const first = renderOnce();
    await waitFor(() => expect(createDriver).toHaveBeenCalledTimes(1));
    first.unmount();

    renderOnce();
    await waitFor(() => expect(screen.getByText(/disabled:true/)).toBeInTheDocument());
    expect(createDriver).toHaveBeenCalledTimes(1);
  });

  // Issue #110: EntryStoreLayout used to return a bare `<Outlet>` while the
  // store was opening, then switch to an inner `<Ready>` component (which
  // called `useHistory` itself) once it was — two different element types
  // in the exact same position across those two renders, which React
  // reconciles by unmounting the old subtree and mounting a fresh one. Every
  // route rendered under here paid for that with a hidden remount ~50-100ms
  // after first paint; on `/reflect` specifically, landing inside that
  // window aborted whatever `/v1/reflect` fetch had just started
  // (`activeAbortRef`'s cleanup in reflection-page.tsx runs on any unmount,
  // not only a real navigation away). This asserts directly on the mount
  // count, at the seam the bug actually lived in, rather than on a
  // downstream symptom two more layers away.
  it("keeps the routed subtree mounted across the store opening (issue #110)", async () => {
    let resolveDriver: (value: unknown) => void = () => {};
    createDriver.mockReturnValue(
      new Promise((resolve) => {
        resolveDriver = resolve;
      }),
    );
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    openMock.mockResolvedValue({ store, taskStore, deviceId: "device-a" });

    const fresh = await importFresh();
    activeUseEntryStore = fresh.useEntryStore;

    render(
      <QueryClientProvider client={fresh.queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<fresh.EntryStoreLayout />}>
              <Route path="/" element={<MountProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(mountEvents).toEqual(["mount"]);

    // The store finishing its (async) open is what used to trigger the
    // remount — resolving it here is what would have exposed the old bug.
    resolveDriver({});
    await waitFor(() => expect(store.list).toHaveBeenCalled());

    expect(mountEvents).toEqual(["mount"]);
  });

  // Issue #186 / ADR 0057. `tsc -b` already catches a method left off one
  // of this file's own `*_STORE_METHODS` registries — that is a compile
  // error, not this test's job to repeat. What nothing here proved before
  // this ticket is the other half `defer-store.ts`'s own doc comment
  // names: that a method actually *listed* in a registry is genuinely
  // forwarded at runtime, called through the facade before the real store
  // has opened — the exact path every other test in this file, and every
  // other store-consuming test in this codebase, avoids by construction
  // (a real caller always waits for `data` first). `sync()` calls
  // `catchUpRowShapeEpoch`/`catchUpProjectRowShapeEpoch`/
  // `catchUpSectionRowShapeEpoch` on every store handle it's given before
  // anything else in its loop (`sync-engine.ts`'s own doc comment on the
  // catch-up it runs first), which makes it exactly the right probe: a
  // registry missing any of the three would surface here as `undefined is
  // not a function` on the very first call, the identical failure a
  // Device on the deferred path hit for real (reported alongside this
  // fix) while every vitest suite stayed green.
  it("forwards catchUpRowShapeEpoch and its Project/Section siblings through every deferred facade before the store opens", async () => {
    let resolveOpen: (data: {
      store: EntryStore;
      taskStore: TaskStore;
      projectStore: ProjectStore;
      labelStore: LabelStore;
      commentStore: CommentStore;
      eventStore: EventStore;
      deviceId: string;
    }) => void = () => {};
    const openPromise = new Promise<{
      store: EntryStore;
      taskStore: TaskStore;
      projectStore: ProjectStore;
      labelStore: LabelStore;
      commentStore: CommentStore;
      eventStore: EventStore;
      deviceId: string;
    }>((resolve) => {
      resolveOpen = resolve;
    });

    // The real facades EntryStoreLayout itself builds — through the same
    // exported helpers, over the same not-yet-resolved promise, rather
    // than a second hand-rolled stand-in that could drift from what
    // production actually constructs.
    const store = deferUntilOpen(openPromise);
    const taskStore = deferTaskStoreUntilOpen(openPromise);
    const projectStore = deferProjectStoreUntilOpen(openPromise);
    const labelStore = deferLabelStoreUntilOpen(openPromise);
    const commentStore = deferCommentStoreUntilOpen(openPromise);
    const eventStore = deferEventStoreUntilOpen(openPromise);

    // `sync()` starts here, against the *pending* facades — before
    // `resolveOpen` below ever runs. Only the methods sync()'s own
    // catch-up-then-loop actually calls need a real implementation; every
    // other method is never reached by this test, so it's cast rather
    // than fully implemented, the same bare-cast convention
    // sync-runner.test.ts's own `fakeProjectStore` already uses for a
    // store `sync()` never touches beyond what's stubbed here.
    const syncPromise = sync({
      store,
      taskStore,
      projectStore,
      labelStore,
      commentStore,
      eventStore,
      transport: async () => ({
        entries: [],
        cursor: 0,
        tasks: [],
        task_cursor: 0,
        projects: [],
        project_cursor: 0,
        sections: [],
        section_cursor: 0,
        labels: [],
        label_cursor: 0,
        comments: [],
        comment_cursor: 0,
        events: [],
        event_cursor: 0,
        // Issue #194: always present on the wire — see sync-engine.test.ts's
        // own `emptyResponse` for why every stream here is empty.
        acknowledged_entries: [],
        acknowledged_tasks: [],
        acknowledged_projects: [],
        acknowledged_sections: [],
        acknowledged_labels: [],
        acknowledged_comments: [],
        acknowledged_events: [],
      }),
      deviceId: "device-a",
    });

    resolveOpen({
      store: {
        pending: vi.fn(async () => []),
        getCursor: vi.fn(async () => 0),
        setCursor: vi.fn(async () => {}),
        catchUpRowShapeEpoch: vi.fn(async () => {}),
      } as unknown as EntryStore,
      taskStore: {
        pending: vi.fn(async () => []),
        getCursor: vi.fn(async () => 0),
        setCursor: vi.fn(async () => {}),
        catchUpRowShapeEpoch: vi.fn(async () => {}),
      } as unknown as TaskStore,
      projectStore: {
        pendingProjects: vi.fn(async () => []),
        getProjectCursor: vi.fn(async () => 0),
        setProjectCursor: vi.fn(async () => {}),
        catchUpProjectRowShapeEpoch: vi.fn(async () => {}),
        pendingSections: vi.fn(async () => []),
        getSectionCursor: vi.fn(async () => 0),
        setSectionCursor: vi.fn(async () => {}),
        catchUpSectionRowShapeEpoch: vi.fn(async () => {}),
      } as unknown as ProjectStore,
      labelStore: {
        pending: vi.fn(async () => []),
        getCursor: vi.fn(async () => 0),
        setCursor: vi.fn(async () => {}),
        catchUpRowShapeEpoch: vi.fn(async () => {}),
      } as unknown as LabelStore,
      commentStore: {
        pending: vi.fn(async () => []),
        getCursor: vi.fn(async () => 0),
        setCursor: vi.fn(async () => {}),
        catchUpRowShapeEpoch: vi.fn(async () => {}),
      } as unknown as CommentStore,
      eventStore: {
        pending: vi.fn(async () => []),
        getCursor: vi.fn(async () => 0),
        setCursor: vi.fn(async () => {}),
        catchUpRowShapeEpoch: vi.fn(async () => {}),
      } as unknown as EventStore,
      deviceId: "device-a",
    });

    // Resolves — not "undefined is not a function" — proving every one of
    // the six facades genuinely forwards its own catch-up method(s), not
    // merely that a registry object happens to type-check.
    await expect(syncPromise).resolves.toBeUndefined();
  });
});
