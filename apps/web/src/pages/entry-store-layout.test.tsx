import type {
  CommentStore,
  Entry,
  EntryStore,
  EventStore,
  LabelStore,
  ProjectStore,
  TaskStore,
} from "@meologue/core";
import { sync } from "@meologue/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Issue #214: the soft-break migration effect, stubbed for the identical
// reason `runTasksBackfillOnceMock` above is — this file's own tests don't
// care about `soft-break-migration.ts`'s own scanning logic
// (soft-break-migration.test.ts owns that), only that this layout kicks it
// off, in order, once the real store opens.
const { runSoftBreakMigrationOnceMock } = vi.hoisted(() => ({
  runSoftBreakMigrationOnceMock: vi.fn(async () => {}),
}));
vi.mock("@/lib/soft-break-migration", () => ({
  runSoftBreakMigrationOnce: runSoftBreakMigrationOnceMock,
}));

function createFakeStore(): EntryStore {
  return {
    list: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    applyPulled: vi.fn(async () => {}),
    applyAcknowledged: vi.fn(async () => {}),
    pending: vi.fn(async () => []),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
    // Issue #186 / ADR 0057.
    catchUpRowShapeEpoch: vi.fn(async () => {}),
    // Issue #214 / ADR 0067.
    hasCompletedSoftBreakMigration: vi.fn(async () => true),
    markSoftBreakMigrationComplete: vi.fn(async () => {}),
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
    applyPulled: vi.fn(async () => {}),
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
    setDateString: vi.fn(async () => {}),
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
  const { disabled, message, messageAction } = activeUseEntryStore();
  return (
    <>
      <p>{`disabled:${disabled} message:${message ?? "none"}`}</p>
      <p>{`action:${messageAction?.href ?? "none"}`}</p>
    </>
  );
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
    runSoftBreakMigrationOnceMock.mockClear();
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
    // No message on this fixture on purpose: this pins that an empty
    // message produces the plain sentence with no dangling " ()".
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
          "disabled:true message:meologue can't store Entries here — this browser wouldn't open storage. Try a non-private window.",
        ),
      ).toBeInTheDocument(),
    );
  });

  // Issue #159's own regression: the originating DOMException's name/message
  // used to reach only the console, invisible on a tablet with no devtools —
  // this pins that a non-empty error message is appended in parentheses so
  // it reaches the reader too.
  it("appends the originating error's own message in parentheses when StorageUnavailableError carries one", async () => {
    const fresh = await importFresh();
    const rejection = Promise.reject(
      new fresh.StorageUnavailableError("SecurityError: The operation is insecure."),
    );
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
          "disabled:true message:meologue can't store Entries here — this browser wouldn't open storage. Try a non-private window. (SecurityError: The operation is insecure.)",
        ),
      ).toBeInTheDocument(),
    );
  });

  // Checked before StorageUnavailableError in describeOpenError, and must
  // NOT read the same as that branch's sentence above: this one names a fix
  // (a different URL) rather than only a cause, so the two sentences read
  // as genuinely different failures on screen, mirroring OpenTimeoutError's
  // own "must not read the same as the fallback" test below.
  it("puts a distinct, HTTP-specific message on the outlet when the context is insecure", async () => {
    const fresh = await importFresh();
    const rejection = Promise.reject(new fresh.InsecureContextError());
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
          "disabled:true message:meologue can't store Entries over plain HTTP — open this page over HTTPS, or on localhost.",
        ),
      ).toBeInTheDocument(),
    );
  });

  // httpsOriginHint (@/lib/https-origin-hint.ts) reads window.location
  // directly rather than taking a parameter here — describeOpenError calls
  // it with no argument — so the only reliable way to control it under
  // jsdom is stubbing window.location itself for the two cases below,
  // mirroring data-section.test.tsx's own Object.defineProperty pattern for
  // the identical reason (Location's setters throw on jsdom for a bare
  // property assignment).
  describe("the InsecureContextError action link", () => {
    let originalLocation: Location;

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    });

    it("yields an action href on an http: .ts.net origin", async () => {
      originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: {
          ...originalLocation,
          protocol: "http:",
          hostname: "hemangs-macbook-air-1.tail28560e.ts.net",
        },
      });

      const fresh = await importFresh();
      const rejection = Promise.reject(new fresh.InsecureContextError());
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
          screen.getByText("action:https://hemangs-macbook-air-1.tail28560e.ts.net/"),
        ).toBeInTheDocument(),
      );
    });

    it("yields no action on a non-.ts.net http origin", async () => {
      originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: {
          ...originalLocation,
          protocol: "http:",
          hostname: "192.168.1.5",
        },
      });

      const fresh = await importFresh();
      const rejection = Promise.reject(new fresh.InsecureContextError());
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

      await waitFor(() => expect(screen.getByText("action:none")).toBeInTheDocument());
    });
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

  // Issue #214 / ADR 0067: the soft-break migration's own store-open
  // trigger — pins down both that EntryStoreLayout calls it with the real
  // opened stores/deviceId, and that it does not start until the Tasks
  // backfill above has actually *resolved*, not merely been called
  // (soft-break-migration.ts's own header comment on why the ordering
  // matters: that backfill rewrites bodies too, and this migration must
  // see the final text). soft-break-migration.test.ts owns whether the
  // migration itself does the right thing once called.
  it("kicks off the soft-break migration only after the Tasks backfill has resolved", async () => {
    createDriver.mockResolvedValue({});
    const store = createFakeStore();
    const taskStore = createFakeTaskStore();
    const projectStore = {} as ProjectStore;
    const labelStore = {} as LabelStore;
    const commentStore = {} as CommentStore;
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

    let resolveBackfill: () => void = () => {};
    runTasksBackfillOnceMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveBackfill = resolve;
        }),
    );

    await renderLayout();

    await waitFor(() => expect(runTasksBackfillOnceMock).toHaveBeenCalledTimes(1));
    // The backfill is still pending — the migration must not have started.
    expect(runSoftBreakMigrationOnceMock).not.toHaveBeenCalled();

    resolveBackfill();

    await waitFor(() => expect(runSoftBreakMigrationOnceMock).toHaveBeenCalledTimes(1));
    expect(runSoftBreakMigrationOnceMock).toHaveBeenCalledWith(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      "device-a",
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

// The bug this covers: a browser reload starts `useHistory`'s infinite
// query cold — one page — so the newest-end jump in History always lands
// against a real, mostly-measured `scrollHeight`. Returning to the
// Composer from another route inside the app is not a reload — this layout
// sits above `/composer`, `/reflect`, `/digest` and `/todo*` alike and
// never unmounts between them (issue #110, this file's own describe block
// above), so the query it owns keeps every page the reader scrolled back
// through earlier, and a freshly-mounted, virtualized History renders all
// of it sight-unseen at estimated row heights — the root cause behind
// "returning to the Composer lands on a wrong day instead of the newest
// Entry" (see `resetEntriesPagingToNewest`'s own doc comment,
// entries-pagination.ts, for the full mechanism). These tests exercise the
// fix through the real routing + real `useHistory` this layout wires
// together, not a unit test of the trimming function in isolation
// (entries-pagination.test.ts already owns that).
describe("EntryStoreLayout resetting Composer's pagination on a fresh visit", () => {
  function historyEntry(overrides: Partial<Entry> = {}): Entry {
    return {
      id: "entry",
      deviceId: "device-a",
      body: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      ...overrides,
    };
  }

  // Reads straight off `useEntryStore()` rather than duplicating History's
  // own rendering — this describe block is testing whether the CACHE gets
  // trimmed on the route transition, not how History renders whatever it's
  // handed (history.test.tsx already owns that).
  function PaginationProbe() {
    const { entries, pagination } = activeUseEntryStore();
    return (
      <>
        <p data-testid="count">{entries.length}</p>
        <button type="button" onClick={pagination.fetchMore}>
          Load older
        </button>
      </>
    );
  }

  // A real route change, not a prop change — `resetEntriesPagingToNewest`'s
  // own call site (entry-store-layout.tsx) keys off `useLocation().pathname`
  // specifically because only a genuine navigation should trim anything.
  function NavButtons() {
    const navigate = useNavigate();
    return (
      <>
        <button type="button" onClick={() => navigate("/reflect")}>
          Go reflect
        </button>
        <button type="button" onClick={() => navigate("/composer")}>
          Go composer
        </button>
      </>
    );
  }

  it("drops every page but the newest when the reader returns to /composer from Reflect, matching a reload's own starting point", async () => {
    const { ENTRIES_PAGE_SIZE } = await import("@/lib/entries-pagination");
    const pageOne = Array.from({ length: ENTRIES_PAGE_SIZE }, (_, i) =>
      historyEntry({
        id: `newest-${i}`,
        createdAt: `2026-02-01T00:${String(59 - i).padStart(2, "0")}:00.000Z`,
      }),
    );
    const pageTwo = [historyEntry({ id: "older-1", createdAt: "2026-01-01T00:00:00.000Z" })];
    const store = createFakeStore();
    store.list = vi.fn(async (pageParam?: { before?: unknown }) =>
      pageParam?.before ? pageTwo : pageOne,
    );
    const taskStore = createFakeTaskStore();
    openMock.mockResolvedValue({ store, taskStore, deviceId: "device-a" });

    const fresh = await importFresh();
    activeUseEntryStore = fresh.useEntryStore;

    render(
      <QueryClientProvider client={fresh.queryClient}>
        <MemoryRouter initialEntries={["/composer"]}>
          <NavButtons />
          <Routes>
            <Route element={<fresh.EntryStoreLayout />}>
              <Route path="/composer" element={<PaginationProbe />} />
              <Route path="/reflect" element={<p>on reflect</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent(String(ENTRIES_PAGE_SIZE)),
    );

    // Scrolls back once — the same accumulation a reader paging up through
    // History produces — before ever leaving the Composer.
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent(
        String(ENTRIES_PAGE_SIZE + pageTwo.length),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Go reflect" }));
    await screen.findByText("on reflect");

    fireEvent.click(screen.getByRole("button", { name: "Go composer" }));

    // Back on /composer: only the newest page survives the round trip —
    // not the two pages the earlier scroll-back left cached, and no extra
    // `store.list` call either (the trim itself does no fetch — see
    // `resetEntriesPagingToNewest`'s own doc comment on why page zero
    // needs none).
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent(String(ENTRIES_PAGE_SIZE)),
    );
    expect(store.list).toHaveBeenCalledTimes(2);
  });

  it("does not touch the cache on an ordinary re-render that never leaves /composer", async () => {
    const { ENTRIES_PAGE_SIZE } = await import("@/lib/entries-pagination");
    const pageOne = Array.from({ length: ENTRIES_PAGE_SIZE }, (_, i) =>
      historyEntry({
        id: `newest-${i}`,
        createdAt: `2026-02-01T00:${String(59 - i).padStart(2, "0")}:00.000Z`,
      }),
    );
    const pageTwo = [historyEntry({ id: "older-1", createdAt: "2026-01-01T00:00:00.000Z" })];
    const store = createFakeStore();
    store.list = vi.fn(async (pageParam?: { before?: unknown }) =>
      pageParam?.before ? pageTwo : pageOne,
    );
    const taskStore = createFakeTaskStore();
    openMock.mockResolvedValue({ store, taskStore, deviceId: "device-a" });

    const fresh = await importFresh();
    activeUseEntryStore = fresh.useEntryStore;

    render(
      <QueryClientProvider client={fresh.queryClient}>
        <MemoryRouter initialEntries={["/composer"]}>
          <Routes>
            <Route element={<fresh.EntryStoreLayout />}>
              <Route path="/composer" element={<PaginationProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent(String(ENTRIES_PAGE_SIZE)),
    );

    fireEvent.click(screen.getByRole("button", { name: "Load older" }));

    // Both pages stay loaded — nothing about clicking "Load older" itself
    // is a route change, so the reset this describe block exists to test
    // must never fire here.
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent(
        String(ENTRIES_PAGE_SIZE + pageTwo.length),
      ),
    );
  });
});
