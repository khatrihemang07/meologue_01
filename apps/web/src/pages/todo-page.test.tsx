import type { Comment, Event, Project, Section, Task } from "@meologue/core";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import {
  Link,
  MemoryRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import { TODO_SIDEBAR_QUERY, WIDE_LAYOUT_QUERY } from "@/hooks/use-wide-layout";
import {
  clearLastTodoView,
  lastTodoPath,
  readLastTodoView,
  writeLastTodoView,
} from "@/lib/last-todo-view";
import { localDayKey } from "@/lib/local-day-key";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { TodoPage } from "./todo-page";

const { openEntryStoreMock } = vi.hoisted(() => ({
  openEntryStoreMock: vi.fn(),
}));

// TodoSidebar's own header comment: it reads the Entry store directly via
// `entryStoreQueryOptions`, the same TanStack Query cache
// `EntryStoreLayout` itself populates, rather than through the
// `EntryStoreOutletContext` `renderTodoPage` stubs below for `TodoPage`
// itself — mocked here exactly as `todo-sidebar.test.tsx` and
// `chat-shell-layout.test.tsx` (its own former copy of this mock, before
// the owner's amendment to ADR 0076 moved the sidebar's mount point here)
// already do, so mounting it via `TodoPage`'s own lazy import needs no
// real SqliteDriver. A *partial* mock, unlike those two files' own full
// replacement: `TodoPage` itself (unlike `TodoSidebar` or
// `ChatShellLayout`) imports `useEntryStore` from this same module at its
// own top level, so a full replacement here breaks every test in this
// file, not just the sidebar-column ones — `importOriginal` keeps that
// export (and everything else real) intact and only re-points
// `entryStoreQueryOptions`. Harmless for every test that never triggers
// `sidebarWide` (`installWideMatchMedia`/`installNarrowMatchMedia` below
// are both query-aware and leave `TODO_SIDEBAR_QUERY` unanswered, so
// `LazyTodoSidebar` never mounts under them at all) — this mock only ever
// matters to the dedicated sidebar-column tests near the bottom of this
// file.
vi.mock("@/pages/entry-store-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pages/entry-store-layout")>();
  return {
    ...actual,
    entryStoreQueryOptions: queryOptions({
      queryKey: ENTRY_STORE_QUERY_KEY,
      queryFn: openEntryStoreMock,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
      retry: false,
      retryOnMount: false,
    }),
  };
});

vi.mock("@/components/ui/toast", () => {
  const toast = vi.fn() as unknown as typeof import("@/components/ui/toast").toast;
  // biome-ignore lint/suspicious/noExplicitAny: attaching mock methods to a mock function, the same shape sonner's own `toast` carries in production (a callable object with `.error`/`.custom`/`.dismiss` etc as properties).
  (toast as any).error = vi.fn();
  let nextCustomToastId = 1;
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  (toast as any).custom = vi.fn(() => `custom-toast-${nextCustomToastId++}`);
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  (toast as any).dismiss = vi.fn();
  return { toast };
});

/**
 * Stands in for the real `TaskTitleEditor` — issue #226 converted
 * `AddTaskForm`'s own Quick Add field onto it, so this page mounts one
 * unconditionally now, not only once a Task row enters rename mode.
 * task-title-editor.tsx's own header comment explains why no test mounts
 * that component directly (a real ProseMirror `EditorView`, which jsdom
 * cannot usefully mount); task-detail-view.test.tsx and task-row.test.tsx
 * mock the identical module the identical way. `onChange` is wired here
 * (theirs isn't) because add-task-form.tsx's own `commit` reads Quick
 * Add's live text from it, not from `onCommit` alone the way a rename
 * does.
 */
function StubTaskTitleEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange?: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      aria-label={ariaLabel ?? "Task name"}
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange?.(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit(text);
        }
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

async function revealAddTaskField(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
}

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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

// Issue #388: the `#project`/`@label`/`/section` name-list tests below
// need real Project/Section fixtures — a typed `#Word` no longer matches
// unless "Word" is a name this page's own `projects` prop actually
// carries (this ticket's own headline change).
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    deviceId: "device-a",
    name: "Work",
    colour: "#DC4C3E",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "A",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function section(overrides: Partial<Section> = {}): Section {
  return {
    id: "s1",
    deviceId: "device-a",
    projectId: "p1",
    name: "Cutover",
    description: null,
    orderKey: "A",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

// The identical shape task-detail-view.test.tsx's own local `comment()`
// fixture uses — this file had no need of one until issue #306's own
// comment-badge tests below.
function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    deviceId: "device-a",
    taskId: "1",
    text: "sounds good",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

// EntryStoreLayout normally supplies this context (it owns both stores and
// runs useHistory/useTasks) — stubbing it with a bare Outlet lets these
// tests exercise TodoPage in isolation with a context of their own
// choosing, the same technique composer-page.test.tsx already uses for the
// Entry half of this same context. Wrapped in a fresh QueryClientProvider,
// same reasoning composer-page.test.tsx's own `renderComposerPage` gives:
// issue #171 is what first made TodoPage call `useQuery` directly (`
// scopedTasksQuery`/`sectionsQuery`, todo-page.tsx), not only through
// context-supplied functions the way it did before.
// Issue #307. Stands in for a hardware/browser Back press — MemoryRouter
// has no `window.history` of its own for a real Back gesture to act on, so
// this drives the identical mechanism a real Back press triggers
// (`navigate(-1)` popping the router's own in-memory stack), the same way
// composer-page.test.tsx's own `GoBackProbe` and digest-reader-page.test.tsx's
// own identical stand-in already simulate Back in this codebase.
function GoBackProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Simulate Back
    </button>
  );
}

// Issue #353 (ADR 0086): renders the current pathname so a test can assert
// exactly where a navigation landed, mirroring digest-reader-page.test.tsx's
// own identical `LocationProbe`.
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location-path">{location.pathname}</p>;
}

// `initialEntries` defaults to just the reader's own path — the same single
// -entry stack (so `location.key === "default"`, the cold-load/deep-link
// case) every pre-existing test in this file already renders against.
// Issue #353's own tests, which need Todo actually *entered* (so there's a
// real entry behind it for Back to pop to), pass their own multi-entry
// stack instead.
function renderTodoPage(
  context: EntryStoreOutletContext,
  initialPath = "/todo/inbox",
  initialEntries: string[] = [initialPath],
) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
        {/* A real link to a non-`/todo/*` route (ADR 0049's own suggested
            test shape: "navigate to `/composer` ... through the router") —
            TodoPage itself has no reason to link to Composer, so this is the
            test's own way out, not a control this ticket adds to the page. */}
        <Link to="/composer">Leave Todo</Link>
        <GoBackProbe />
        <LocationProbe />
        <Routes>
          <Route element={<Outlet context={context} />}>
            {/* Issue #352: mirrors App.tsx's own bare `/todo` redirect —
                `lastTodoPath()` resolves to the remembered view instead of
                the literal `"/todo/inbox"` this route used to carry, so a
                test can drive the same redirect this helper's callers rely
                on rather than a second, hand-rolled one. */}
            <Route path="/todo" element={<Navigate to={lastTodoPath()} replace />} />
            <Route path="/todo/inbox" element={<TodoPage />} />
            <Route path="/todo/today" element={<TodoPage view="today" />} />
            {/* Issue #254: added for the in-column heading's own tests
                below — no earlier ticket needed Upcoming reachable through
                this helper's router. */}
            <Route path="/todo/upcoming" element={<TodoPage view="upcoming" />} />
            <Route path="/todo/projects" element={<TodoPage view="projects" />} />
            <Route path="/todo/projects/:projectId" element={<TodoPage view="project" />} />
            <Route path="/todo/activity" element={<TodoPage view="activity" />} />
            <Route path="/todo/filters" element={<TodoPage view="filters" />} />
            <Route path="/todo/filters/new" element={<TodoPage view="filter" />} />
            <Route path="/todo/filters/:filterId" element={<TodoPage view="filter" />} />
            {/* Issue #352's own "specific ... Label" acceptance criterion
                — mirrors App.tsx's real `/todo/labels`, not otherwise
                needed by this helper's earlier callers. */}
            <Route path="/todo/labels" element={<TodoPage view="labels" />} />
            {/* Issue #307: Search's own route, mirroring App.tsx's real
                `/todo/search` — needed for the header search door's own
                tests below. */}
            <Route path="/todo/search" element={<TodoPage view="search" />} />
            <Route path="/todo/browse" element={<TodoPage view="browse" />} />
            {/* Issue #178's Task detail route — no `view` prop, mirroring
                App.tsx's own identical route exactly (that file's own
                comment explains why). */}
            <Route path="/todo/task/:taskSlugId" element={<TodoPage />} />
            <Route path="/composer" element={<p>Composer</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function readyContext(overrides: Partial<EntryStoreOutletContext> = {}): EntryStoreOutletContext {
  return {
    entries: [],
    sendEntry: vi.fn(),
    editEntry: vi.fn(),
    commitEntryEdit: vi.fn(),
    removeEntry: vi.fn(),
    search: vi.fn(async () => []),
    getEntries: vi.fn(async () => []),
    pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
    tasks: [],
    completedTasks: [],
    addTask: vi.fn(),
    completeTask: vi.fn(),
    uncompleteTask: vi.fn(),
    renameTask: vi.fn(),
    reorderTask: vi.fn(),
    reorderTaskToday: vi.fn(),
    removeTask: vi.fn(),
    setTaskDate: vi.fn(),
    setTaskPriority: vi.fn(),
    setTaskDateString: vi.fn(),
    setTaskLabels: vi.fn(),
    setTaskDescription: vi.fn(),
    listTasksInProject: vi.fn(async () => []),
    listTaskChildren: vi.fn(async () => []),
    countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
    listTasksInSection: vi.fn(async () => []),
    listTaskDescendants: vi.fn(async () => []),
    advanceRecurringTask: vi.fn(),
    completeForeverTask: vi.fn(),
    postponeTask: vi.fn(),
    setTaskProject: vi.fn(),
    setTaskSection: vi.fn(),
    setTaskParent: vi.fn(async () => {}),
    labels: [],
    resolveLabelIds: vi.fn(async () => []),
    // Issue #370 — a distinctive default (not the typed name verbatim, not
    // empty) so a test asserting `addTask`'s own `projectId`/`sectionId`
    // can tell "this call reached resolveProjectId/resolveSectionId" apart
    // from "this call happened to pass the raw name through unresolved".
    resolveProjectId: vi.fn(async (name: string) => `resolved-project:${name}`),
    resolveSectionId: vi.fn(
      async (projectId: string, name: string) => `resolved-section:${projectId}:${name}`,
    ),
    comments: [],
    addComment: vi.fn(),
    editComment: vi.fn(),
    removeComment: vi.fn(),
    projects: [],
    addProject: vi.fn(),
    renameProject: vi.fn(),
    setProjectColour: vi.fn(),
    setProjectDescription: vi.fn(),
    setProjectFavourite: vi.fn(),
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
    setProjectParent: vi.fn(async () => {}),
    reorderProject: vi.fn(),
    listSections: vi.fn(async () => []),
    addSection: vi.fn(async () => {}),
    renameSection: vi.fn(),
    setSectionDescription: vi.fn(),
    reorderSection: vi.fn(),
    deleteSection: vi.fn(),
    archiveSection: vi.fn(),
    unarchiveSection: vi.fn(),
    events: [],
    listEventsByTask: vi.fn(async () => []),
    listEventsByProject: vi.fn(async () => []),
    filters: [],
    addFilter: vi.fn(() => "filter-1"),
    renameFilter: vi.fn(),
    setFilterColour: vi.fn(),
    setFilterQuery: vi.fn(async () => {}),
    removeFilter: vi.fn(),
    addLabel: vi.fn(),
    renameLabel: vi.fn(),
    setLabelColour: vi.fn(),
    removeLabel: vi.fn(),
    removeProject: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

// Inbox no longer reads its list off `tasks` directly (todo-page.tsx's own
// doc comment: `tasks` stayed the flat, cross-Project feed once a Task
// could live somewhere other than Inbox) — it reads `listTasksInProject
// (null)` instead, through TaskList/TaskTree's own `useQuery`. A test that
// wants Inbox to render a given set of Tasks has to supply both: `tasks`
// itself, so `confirmingTask`/`schedulingTask`'s own by-id lookup (still
// against the flat array — every Task anywhere is still in it) can find
// the row a reader just acted on, and `listTasksInProject` for what
// actually renders. This helper keeps that pairing from being repeated,
// and drifting, at every call site below.
function inboxContext(
  tasksList: Task[],
  overrides: Partial<EntryStoreOutletContext> = {},
): EntryStoreOutletContext {
  return readyContext({
    tasks: tasksList,
    listTasksInProject: vi.fn(async (projectId: string | null) =>
      projectId === null ? tasksList : [],
    ),
    ...overrides,
  });
}

/** Every row this stub gives a rect is `ROW_HEIGHT` tall, stacked with no gaps. */
const ROW_HEIGHT = 40;

describe("TodoPage", () => {
  beforeEach(() => {
    vi.mocked(toast).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.custom).mockClear();
    vi.mocked(toast.dismiss).mockClear();

    // jsdom lays nothing out — `getBoundingClientRect` is always zero
    // (`history.tsx`'s own comment names the identical gap) — so the drop
    // geometry `task-tree.tsx` reads off real row rects needs a stand-in
    // here. Each row's rect is derived purely from its position among its
    // DOM siblings, which is all `dropIndexForPointer` ever looks at.
    //
    // Issue #192 nested a row's own sub-task `<ul>` *inside* that row's
    // own `<li>`, and `measureRows` (task-tree.tsx) now reads each row's
    // own `[data-task-row-box]` rather than the `<li>` itself (that
    // file's own header comment explains why: the `<li>` now encloses any
    // already-rendered subtree too, which would otherwise report a
    // height tall enough to swallow several rows). This stub keys its
    // stacked, `ROW_HEIGHT`-tall positions off the *row* regardless of
    // which of the two elements actually asked — `closest("li")` finds
    // the same `<li>` whether `this` is the `<li>` itself or the row box
    // inside it — so every Inbox row here (none of which have sub-tasks
    // in these tests) still stacks with no gaps exactly as before.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const li = this.closest("li") ?? this;
      const siblings = li.parentElement ? Array.from(li.parentElement.children) : [];
      const index = siblings.indexOf(li);
      const top = index * ROW_HEIGHT;
      return {
        top,
        bottom: top + ROW_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        height: ROW_HEIGHT,
        x: 0,
        y: top,
        toJSON() {},
      } as DOMRect;
    });

    // jsdom implements no pointer capture at all — `task-tree.tsx`'s own
    // handlers wrap the call in a try/catch for exactly that reason
    // (`use-swipe-actions.ts` hits the identical gap). Stubbing it here
    // rather than leaning on that catch keeps these tests asserting the
    // capture calls actually happen, not merely that nothing throws.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The grip handle inside the row that renders `label`. */
  function dragHandle(label: string): HTMLElement {
    const row = screen.getByText(label).closest("li");
    if (!row) throw new Error(`expected a row for "${label}"`);
    const handle = row.querySelector<HTMLElement>('[data-testid="task-drag-handle"]');
    if (!handle) throw new Error(`expected a drag handle on "${label}"'s row`);
    return handle;
  }

  it("offers a Back control out to the root screen", () => {
    renderTodoPage(readyContext());

    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
  });

  it("renders its own internal navigation, scoped to Todo (ADR 0049)", () => {
    renderTodoPage(readyContext());

    expect(screen.getByRole("navigation", { name: "Todo" })).toBeInTheDocument();
  });

  // ADR 0049's own suggested regression test: Todo's nav has to actually
  // leave the tree on navigating away, not merely become invisible —
  // otherwise "scoped to Todo" is a claim this ticket makes and nothing
  // checks.
  it("unmounts its internal navigation once the reader leaves Todo", () => {
    renderTodoPage(readyContext());
    expect(screen.getByRole("navigation", { name: "Todo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Leave Todo" }));

    expect(screen.getByText("Composer")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Todo" })).not.toBeInTheDocument();
  });

  // Issue #178's own Task route is still `/todo/*` — ADR 0049's own
  // constraint on where Todo's internal navigation may live has to hold
  // for it too, not only for Inbox/Today/Projects.
  it("still shows Todo's own navigation while a Task's own address is open, and still unmounts it on leaving Todo from there", () => {
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })]), "/todo/task/call-mum-a");

    expect(screen.getByRole("navigation", { name: "Todo" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Leave Todo" }));

    expect(screen.getByText("Composer")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Todo" })).not.toBeInTheDocument();
  });

  // A real uuid — `taskIdFromParam`'s own regex (lib/task-detail-route.ts)
  // only ever reads the trailing uuid, so this suite's usual plain `"a"`
  // ids don't resolve to anything and are deliberately reused just above
  // for the "bad/typo'd address must not break nav scoping" case.
  const DETAIL_TASK_ID = "11111111-1111-7111-8111-111111111111";

  it("opens a Task's own view over its background, with a breadcrumb and its own title", async () => {
    renderTodoPage(
      inboxContext([task({ id: DETAIL_TASK_ID, content: "call mum" })]),
      `/todo/task/call-mum-${DETAIL_TASK_ID}`,
    );

    // The background — Inbox, the fallback for a direct link with no
    // `location.state.from` (todo-page.tsx's own `backgroundView` doc
    // comment) — is still rendered, dimmed behind the modal/sheet.
    await waitFor(() => expect(screen.getAllByText("call mum")).not.toHaveLength(0));
    // `LazyTaskDetailView` resolves its `import()` asynchronously
    // (lazy-task-detail-view.ts's own header comment) — `findByRole`,
    // not `getByRole`, tolerates the one microtask/render that takes.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // "Inbox" appears twice inside the dialog — the breadcrumb and the
    // Project attribute row both say it, for different reasons (this
    // file's own comment on the breadcrumb vs. `AttributeRow`'s "Project
    // is never truly unset" doc comment, task-detail-view.tsx) — so this
    // scopes to the breadcrumb's own `<header>` specifically rather than
    // an unscoped match that would resolve to both.
    expect(dialog.querySelector("header")).toHaveTextContent("Inbox");
    expect(within(dialog).getByTestId("task-detail-title")).toHaveTextContent("call mum");
  });

  // The coordinator's own gap-fix report: `openTask` used to be looked up
  // against the active `tasks` array alone, so a completed Task's own
  // address resolved to nothing and silently fell back to Inbox instead
  // of opening — the single most useful row an activity log surfaces
  // (issue #184) linking nowhere.
  it("opens a completed Task's own view too, not just an active one", async () => {
    renderTodoPage(
      inboxContext([], {
        completedTasks: [
          task({
            id: DETAIL_TASK_ID,
            content: "call mum",
            completedAt: "2026-01-02T00:00:00.000Z",
          }),
        ],
      }),
      `/todo/task/call-mum-${DETAIL_TASK_ID}`,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText('Mark "call mum" not done')).toBeChecked();
    const title = within(dialog).getByTestId("task-detail-title");
    expect(title).toHaveClass("completed-task-text");
    expect(title).not.toHaveClass("line-through");
  });

  it("un-completing from a completed Task's own detail view calls uncompleteTask", async () => {
    const uncompleteTask = vi.fn();
    renderTodoPage(
      inboxContext([], {
        completedTasks: [
          task({
            id: DETAIL_TASK_ID,
            content: "call mum",
            completedAt: "2026-01-02T00:00:00.000Z",
          }),
        ],
        uncompleteTask,
      }),
      `/todo/task/call-mum-${DETAIL_TASK_ID}`,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Mark "call mum" not done'));

    expect(uncompleteTask).toHaveBeenCalledWith(DETAIL_TASK_ID);
  });

  // The coordinator's own reproduction, end to end: an Activity row for a
  // completion Event is a real link, and following it lands on a
  // rendered dialog — not the Inbox fallback a resolution gap used to
  // produce.
  it("an Activity link for a completion Event reaches a view that actually renders", async () => {
    const completedTask = task({
      id: DETAIL_TASK_ID,
      content: "call mum",
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    const completionEvent: Event = {
      id: "e1",
      deviceId: "device-a",
      eventType: "completed",
      objectType: "task",
      objectId: DETAIL_TASK_ID,
      taskId: DETAIL_TASK_ID,
      projectId: null,
      occurredAt: "2026-01-02T00:00:00.000Z",
      extra: { content: "call mum" },
      seq: 1,
      syncedAt: "2026-01-02T00:00:00.000Z",
    };
    renderTodoPage(
      readyContext({ completedTasks: [completedTask], events: [completionEvent] }),
      "/todo/activity",
    );

    const link = await screen.findByRole("link", { name: /call mum/ });
    fireEvent.click(link);

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("Esc closes the Task's own view", async () => {
    renderTodoPage(
      inboxContext([task({ id: DETAIL_TASK_ID, content: "call mum" })]),
      `/todo/task/call-mum-${DETAIL_TASK_ID}`,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  describe("issue #306 — a comment badge opens the thread ready to reply", () => {
    function commentedTask(overrides: Partial<Task> = {}): Task {
      return task({ id: DETAIL_TASK_ID, content: "call mum", ...overrides });
    }

    it("activating the row's comment badge opens the detail view with the composer already expanded and focused", async () => {
      renderTodoPage(
        inboxContext([commentedTask()], {
          comments: [comment({ id: "c1", taskId: DETAIL_TASK_ID, text: "sounds good" })],
        }),
      );

      const badge = await screen.findByRole("link", { name: "1 comment" });
      expect(badge).toHaveAttribute(
        "href",
        expect.stringContaining(`/todo/task/call-mum-${DETAIL_TASK_ID}?intent=reply`),
      );
      fireEvent.click(badge);

      const dialog = await screen.findByRole("dialog");
      const field = within(dialog).getByLabelText("Add a comment");
      expect(
        within(dialog).queryByRole("button", { name: "Open comment editor" }),
      ).not.toBeInTheDocument();
      expect(document.activeElement).toBe(field);
    });

    // The regression the ticket calls out by name: every other way of
    // reaching the identical Task's detail view must still leave the
    // composer collapsed at rest.
    it("the Task's own bare address (no intent) still opens the view with the composer collapsed, as any other route does", async () => {
      renderTodoPage(
        inboxContext([commentedTask()], {
          comments: [comment({ id: "c1", taskId: DETAIL_TASK_ID, text: "sounds good" })],
        }),
        `/todo/task/call-mum-${DETAIL_TASK_ID}`,
      );

      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByRole("button", { name: "Open comment editor" }),
      ).toBeInTheDocument();
      expect(within(dialog).queryByLabelText("Add a comment")).not.toBeInTheDocument();
    });

    it("an out-of-date slug alongside the intent still resolves to the right Task, composer expanded", async () => {
      renderTodoPage(
        inboxContext([commentedTask()], {
          comments: [comment({ id: "c1", taskId: DETAIL_TASK_ID, text: "sounds good" })],
        }),
        `/todo/task/some-old-slug-${DETAIL_TASK_ID}?intent=reply`,
      );

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByTestId("task-detail-title")).toHaveTextContent("call mum");
      expect(within(dialog).getByLabelText("Add a comment")).toBeInTheDocument();
    });

    it("an unrelated ?intent= value leaves the composer collapsed — an exact match only", async () => {
      renderTodoPage(
        inboxContext([commentedTask()], {
          comments: [comment({ id: "c1", taskId: DETAIL_TASK_ID, text: "sounds good" })],
        }),
        `/todo/task/call-mum-${DETAIL_TASK_ID}?intent=edit`,
      );

      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByRole("button", { name: "Open comment editor" }),
      ).toBeInTheDocument();
    });
  });

  it("reads an empty Inbox as a real state, not a blank panel", () => {
    renderTodoPage(inboxContext([]));

    expect(screen.getByText(/Nothing in your Inbox/)).toBeInTheDocument();
  });

  it("does not read Inbox as empty when it holds only a completed Task", () => {
    // Issue #358: this scope only falls through to render a completed-only
    // list once `completedTasksVisible` is on — off (the default) reads
    // Inbox as empty here, correctly, since Todoist's own off-state hides
    // the row entirely (task-list.tsx's own doc comment).
    useSettingsStore.getState().setCompletedTasksVisible(true);
    renderTodoPage(
      inboxContext([], {
        completedTasks: [
          task({ id: "a", content: "done already", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
    );

    expect(screen.queryByText(/Nothing in your Inbox/)).not.toBeInTheDocument();
    expect(screen.getByText("done already")).toBeInTheDocument();
    useSettingsStore.getState().setCompletedTasksVisible(false);
  });

  it("lists active Tasks", async () => {
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })]));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    expect(screen.queryByText(/Nothing in your Inbox/)).not.toBeInTheDocument();
  });

  // Inbox is the undated capture bucket (issue #169: "a Task created in
  // Todo starts undated"), so the date this passes is explicitly null
  // rather than absent — see TodoPage's own `captureDate`. `projectId` is
  // `null` too (issue #171's own extension of the identical rule) — Inbox
  // is unfiled by definition, so a Task captured there inherits no Project.
  it("adds a Task through the form, undated and unfiled, when the reader is in Inbox", async () => {
    const addTask = vi.fn();
    renderTodoPage(inboxContext([], { addTask }));

    await revealAddTaskField();
    fireEvent.change(await screen.findByLabelText("Task name"), { target: { value: "call mum" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    // handleAdd (todo-page.tsx) awaits resolveLabelIds before calling
    // addTask — issue #170's own async label-resolution step, invisible
    // here since "call mum" carries no `@label` token to resolve, but
    // still a real microtask this assertion has to wait past.
    await waitFor(() =>
      expect(addTask).toHaveBeenCalledWith(
        "call mum",
        expect.objectContaining({ date: null, dateString: null, labelIds: [], projectId: null }),
      ),
    );
  });

  // The regression this exists for was found by running the built app, not
  // by any test: with Inbox's undated rule applied to Today as well, a Task
  // typed while standing on Today was created undated and therefore absent
  // from every day-keyed view — so it vanished the instant it was added.
  // The plan's "default date is inherited from origin" rule (Todoist's own
  // context inheritance) is what fixes it, and the origin is the *view*.
  it("adds a Task dated today when the reader is standing in Today", async () => {
    const addTask = vi.fn();
    renderTodoPage(readyContext({ addTask }), "/todo/today");

    await revealAddTaskField();
    fireEvent.change(await screen.findByLabelText("Task name"), { target: { value: "call mum" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    await waitFor(() =>
      expect(addTask).toHaveBeenCalledWith(
        "call mum",
        expect.objectContaining({ date: localDayKey(new Date()) }),
      ),
    );
  });

  // The plain-text token's own date is what wins once the reader typed
  // one — captureDate ("Today") is only the fallback quick-add-task.ts's
  // own `??` reaches for when nothing in the line resolved a date at all.
  it("a date the reader typed overrides the view's own inherited date", async () => {
    const addTask = vi.fn();
    renderTodoPage(readyContext({ addTask }), "/todo/today");

    await revealAddTaskField();
    fireEvent.change(await screen.findByLabelText("Task name"), {
      target: { value: "call mum tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    await waitFor(() => expect(addTask).toHaveBeenCalled());
    const [content, overrides] = addTask.mock.calls[0] as [string, { date: string | null }];
    expect(content).toBe("call mum");
    expect(overrides.date).not.toBe(localDayKey(new Date()));
  });

  it("disables the Add form while the store isn't ready", () => {
    renderTodoPage(readyContext({ disabled: true }));

    expect(screen.getByRole("button", { name: "Add task" })).toBeDisabled();
  });

  it("completes a Task and offers an Undo toast wired to uncompleteTask", async () => {
    const completeTask = vi.fn();
    const uncompleteTask = vi.fn();
    renderTodoPage(
      inboxContext([task({ id: "a", content: "call mum" })], { completeTask, uncompleteTask }),
    );

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as complete" }));

    expect(completeTask).toHaveBeenCalledWith("a");
    expect(toast.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        duration: 10_000,
      }),
    );

    const customCall = vi.mocked(toast.custom).mock.calls[0];
    if (!customCall) throw new Error("toast.custom was not called");
    const [jsxFactory] = customCall;
    render(jsxFactory("toast-a"));

    expect(screen.getByText("1 task completed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(uncompleteTask).toHaveBeenCalledWith("a");
    // The Undo click has to dismiss the toast itself now (completion-toast.tsx's
    // own header comment) — sonner's own `action` button did this for free;
    // a bare custom button does not.
    expect(toast.dismiss).toHaveBeenCalledWith("toast-a");
  });

  describe("keyboard undo of a completion", () => {
    it("undoes the most recent completion on 'z'", async () => {
      const completeTask = vi.fn();
      const uncompleteTask = vi.fn();
      renderTodoPage(
        inboxContext([task({ id: "a", content: "call mum" })], { completeTask, uncompleteTask }),
      );

      await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as complete" }));
      expect(completeTask).toHaveBeenCalledWith("a");

      fireEvent.keyDown(document, { key: "z" });

      expect(uncompleteTask).toHaveBeenCalledWith("a");
    });

    it("undoes the most recent completion on Cmd+Z", async () => {
      const completeTask = vi.fn();
      const uncompleteTask = vi.fn();
      renderTodoPage(
        inboxContext([task({ id: "a", content: "call mum" })], { completeTask, uncompleteTask }),
      );

      await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as complete" }));

      fireEvent.keyDown(document, { key: "z", metaKey: true });

      expect(uncompleteTask).toHaveBeenCalledWith("a");
    });

    it("does nothing on 'z' or Cmd+Z when nothing has been completed", () => {
      const uncompleteTask = vi.fn();
      renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })], { uncompleteTask }));

      fireEvent.keyDown(document, { key: "z" });
      fireEvent.keyDown(document, { key: "z", metaKey: true });

      expect(uncompleteTask).not.toHaveBeenCalled();
    });

    it("does not undo a completion when Cmd+Z is pressed while typing in the Add task field", async () => {
      const completeTask = vi.fn();
      const uncompleteTask = vi.fn();
      renderTodoPage(
        inboxContext([task({ id: "a", content: "call mum" })], { completeTask, uncompleteTask }),
      );

      await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as complete" }));
      expect(completeTask).toHaveBeenCalledWith("a");

      await revealAddTaskField();
      const addField = await screen.findByLabelText("Task name");
      addField.focus();
      fireEvent.keyDown(addField, { key: "z", metaKey: true });

      expect(uncompleteTask).not.toHaveBeenCalled();
    });
  });

  it("restores a completed Task inline, through its own checkbox, independent of any toast", () => {
    // Issue #358: this row only renders at all once `completedTasksVisible`
    // is on — see the identical note on the empty-state test above.
    useSettingsStore.getState().setCompletedTasksVisible(true);
    const uncompleteTask = vi.fn();
    renderTodoPage(
      readyContext({
        completedTasks: [
          task({ id: "a", content: "call mum", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
        uncompleteTask,
      }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as incomplete" }));

    expect(uncompleteTask).toHaveBeenCalledWith("a");
    useSettingsStore.getState().setCompletedTasksVisible(false);
  });

  // Issue #178 moved Delete off the row's own hover actions into the
  // "More actions" (⋯) menu — task-row.test.tsx's own equivalent test has
  // the fuller reasoning.
  it("deletes a Task only after confirming, mirroring sessions-page.tsx's ConfirmDialog", async () => {
    const removeTask = vi.fn();
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })], { removeTask }));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(removeTask).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(removeTask).toHaveBeenCalledWith("a");
  });

  it("renders markdown in the delete confirmation's quoted title", async () => {
    renderTodoPage(inboxContext([task({ id: "a", content: "ZZ probe **bold** _em_ `code`" })]));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "ZZ probe bold em code" })).toBeInTheDocument(),
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: 'More actions for "ZZ probe **bold** _em_ `code`"' }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("bold")?.tagName).toBe("STRONG");
    expect(within(dialog).getByText("em")?.tagName).toBe("EM");
    expect(within(dialog).getByText("code")?.tagName).toBe("CODE");
    expect(dialog).toHaveTextContent("The ZZ probe bold em code task will be permanently deleted.");
  });

  it("cancelling the delete confirmation leaves the Task untouched", async () => {
    const removeTask = vi.fn();
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })], { removeTask }));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(removeTask).not.toHaveBeenCalled();
  });

  // ADR 0050's own criterion, exercised end to end through the page rather
  // than only against the pure `dropIndexForPointer` and
  // `reorderedTaskOrderKey` helpers (task-drag-recognizer.test.ts and
  // task-reorder.test.ts already cover those in isolation): dragging one
  // row's handle onto another calls reorderTask exactly once, with a key
  // strictly between the two Tasks it landed among. Pointer events, not
  // native drag-and-drop — Android WebView never synthesises `dragstart`
  // from touch input, so this has to be the same recogniser a real device
  // would drive, not a mechanism only a mouse can trigger.
  it("dragging a Task's handle onto another calls reorderTask exactly once, with a key between its new neighbours", async () => {
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    const c = task({ id: "c", content: "c", orderKey: "C" });
    renderTodoPage(inboxContext([a, b, c], { reorderTask }));

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());

    // "a", "b" and "c" render at DOM indices 0, 1 and 2, so the
    // `getBoundingClientRect` stub above gives them rects 0-40, 40-80 and
    // 80-120. Inbox is a top-level sibling group (depth 1), so nesting is
    // offered here (issue #171's drag-to-reparent) — "c"'s own reorder
    // ("before it") band is only its top quarter, y=[80, 90)
    // (`task-drag-recognizer.ts`'s own `REORDER_EDGE_FRACTION`), not the
    // full top half a pre-#171 midpoint split would have given it.
    // Dragging "a" and releasing at y=85 lands there — dropIndex 1 in the
    // without-"a" list [b, c], strictly between "b" and "c" — without
    // straying into "c"'s own nest band (y=[90, 110)), which this same
    // gesture at the old y=90 now would.
    const handle = dragHandle("a");
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 85 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 85 });

    expect(reorderTask).toHaveBeenCalledTimes(1);
    const [draggedId, newKey] = reorderTask.mock.calls[0] as [string, string];
    expect(draggedId).toBe("a");
    expect(newKey > "B").toBe(true);
    expect(newKey < "C").toBe(true);
  });

  // The no-op this ticket's own brief names explicitly: a release back over
  // the dragged Task's own starting slot must write nothing at all, not a
  // `reorderTask` call whose key happens to land in the same place.
  it("releasing the handle back where the drag began writes nothing", async () => {
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    renderTodoPage(inboxContext([a, b], { reorderTask }));

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());

    // "a" sits at DOM index 0 (rect 0-40); a small move that never leaves
    // its own slot has to resolve back to its own original index.
    const handle = dragHandle("a");
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 20 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 20 });

    expect(reorderTask).not.toHaveBeenCalled();
  });

  // The system taking the gesture away is an abort, not a release —
  // `use-swipe-actions.ts`'s own `pointercancel` path holds the identical
  // contract for a swipe.
  it("a pointercancel mid-drag aborts and writes nothing, even on the pointerup that follows", async () => {
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    const c = task({ id: "c", content: "c", orderKey: "C" });
    renderTodoPage(inboxContext([a, b, c], { reorderTask }));

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());

    const handle = dragHandle("a");
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 90 });
    fireEvent.pointerCancel(handle, { pointerId: 1, clientY: 90 });

    expect(reorderTask).not.toHaveBeenCalled();

    // The cancel really ended the drag rather than merely pausing it — a
    // pointerup landing afterwards must not retroactively commit anything.
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 90 });
    expect(reorderTask).not.toHaveBeenCalled();
  });

  // A regression test for a defect that every other test in this file, the
  // e2e suite, and both other platforms all missed. Without
  // `preventDefault()` here, WebKit starts its own *text selection* drag on
  // the handle's mousedown and owns the gesture from that point on: on the
  // macOS/WKWebView build the row's words highlighted blue as the pointer
  // travelled and no reorder happened at all. Chromium tolerates it, so
  // headless-Chromium e2e and jsdom both stayed green while the shipped
  // desktop app was broken.
  //
  // Asserting on `defaultPrevented` rather than on a reorder, because the
  // reorder is exactly the thing that kept working in every environment
  // that could be tested automatically — the suppression itself is the
  // behaviour with no other observable proxy.
  it("suppresses the platform's own selection drag when the handle is pressed", async () => {
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    renderTodoPage(inboxContext([a, b]));

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());

    const handle = dragHandle("a");
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(pointerDown, "pointerId", { value: 1 });
    Object.defineProperty(pointerDown, "clientY", { value: 10 });
    fireEvent(handle, pointerDown);

    expect(pointerDown.defaultPrevented).toBe(true);
  });

  // Issue #171's keyboard reorder, exercised end to end through the page —
  // lib/task-reorder.test.ts already covers `siblingMoveDropIndex`'s own
  // arithmetic in isolation.
  it("ArrowDown on the handle moves a Task one slot later and writes exactly one reorderTask call", async () => {
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    renderTodoPage(inboxContext([a, b], { reorderTask }));

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    fireEvent.keyDown(dragHandle("a"), { key: "ArrowDown" });

    expect(reorderTask).toHaveBeenCalledTimes(1);
    const [draggedId, newKey] = reorderTask.mock.calls[0] as [string, string];
    expect(draggedId).toBe("a");
    expect(newKey > "B").toBe(true);
  });

  // Issue #171's keyboard reparent — indenting the second Task under the
  // first, then appending it to whatever that Task's own children already
  // are (task-tree.tsx's own `handleIndent` doc comment).
  it("Alt+ArrowRight on the handle reparents a Task under its preceding sibling", async () => {
    const setTaskParent = vi.fn(async () => {});
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    renderTodoPage(inboxContext([a, b], { setTaskParent, reorderTask }));

    await waitFor(() => expect(screen.getByText("b")).toBeInTheDocument());
    fireEvent.keyDown(dragHandle("b"), { key: "ArrowRight", altKey: true });

    await waitFor(() => expect(setTaskParent).toHaveBeenCalledWith("b", "a"));
  });

  // The store throws on the four-level cap or a cycle (TaskStore.setParent's
  // own doc comment) — this ticket's own brief: "decide what the UI does
  // with that and make it legible." A toast, not a swallowed rejection.
  it("shows a toast, rather than a swallowed error, when reparenting is refused", async () => {
    const setTaskParent = vi.fn(async () => {
      throw new Error("sub-tasks may nest at most 4 levels deep (parent is already at depth 4)");
    });
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    renderTodoPage(inboxContext([a, b], { setTaskParent }));

    await waitFor(() => expect(screen.getByText("b")).toBeInTheDocument());
    fireEvent.keyDown(dragHandle("b"), { key: "ArrowRight", altKey: true });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Sub-tasks only nest four levels deep"),
      ),
    );
  });
});

// Issue #247: both rename surfaces now resolve a recognised phrase through
// `commitTaskTitle` (task-title-commit.ts), reached by `commitRename`
// (todo-page.tsx). `toFake: ["Date"]` only, matching task-detail-view-
// recognition.test.tsx's own reasoning — the row/detail title editors sit
// behind `LazyTaskTitleEditor`'s `Suspense` boundary, whose resolution
// `findByLabelText`'s internal polling needs a real `setTimeout` to observe.
describe("TodoPage — rename resolves recognised phrases (issue #247)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026 (Wed), local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves date and priority through the row editor, stripping them from the stored content", async () => {
    const renameTask = vi.fn();
    const setTaskDate = vi.fn();
    const setTaskPriority = vi.fn();
    renderTodoPage(
      inboxContext([task({ id: "a", content: "buy milk" })], {
        renameTask,
        setTaskDate,
        setTaskPriority,
      }),
    );

    await waitFor(() => expect(screen.getByText("buy milk")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
    const editor = await screen.findByLabelText("Task name");
    fireEvent.change(editor, { target: { value: "buy oat milk tomorrow p1" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    // Resolution is async (commitTaskTitle awaits before the last setter
    // it needs could possibly fire) — renameTask is the one whose own
    // resolved value proves the phrase was actually stripped, not just
    // recognised.
    await waitFor(() => expect(renameTask).toHaveBeenCalledWith("a", "buy oat milk"));
    expect(setTaskDate).toHaveBeenCalledWith("a", "2026-09-03");
    expect(setTaskPriority).toHaveBeenCalledWith("a", 4); // p1 UI == stored 4.
  });

  // Issue #370: renaming with a typed `#project` moves the Task — intended,
  // matching how a typed date/priority above already overwrite an existing
  // value on rename.
  it("moves the Task when the row editor's rename types a #project", async () => {
    const setTaskProject = vi.fn();
    const resolveProjectId = vi.fn(async () => "project-work");
    renderTodoPage(
      inboxContext([task({ id: "a", content: "buy milk", projectId: null })], {
        // Issue #388: "Work" has to be a real Project the page knows
        // about for `#Work` to match at all.
        projects: [project({ id: "p1", name: "Work" })],
        setTaskProject,
        resolveProjectId,
      }),
    );

    await waitFor(() => expect(screen.getByText("buy milk")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
    const editor = await screen.findByLabelText("Task name");
    fireEvent.change(editor, { target: { value: "buy oat milk #Work" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(resolveProjectId).toHaveBeenCalledWith("Work"));
    expect(setTaskProject).toHaveBeenCalledWith("a", "project-work");
  });

  it("resolves date and priority through the detail view's own rename", async () => {
    const detailTaskId = "22222222-2222-7222-8222-222222222222";
    const renameTask = vi.fn();
    const setTaskDate = vi.fn();
    const setTaskPriority = vi.fn();
    renderTodoPage(
      inboxContext([task({ id: detailTaskId, content: "buy milk" })], {
        renameTask,
        setTaskDate,
        setTaskPriority,
      }),
      `/todo/task/buy-milk-${detailTaskId}`,
    );

    fireEvent.click(await screen.findByTestId("task-detail-title"));
    const editor = await screen.findByLabelText("Task name");
    fireEvent.change(editor, { target: { value: "buy oat milk tomorrow p1" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(renameTask).toHaveBeenCalledWith(detailTaskId, "buy oat milk"));
    expect(setTaskDate).toHaveBeenCalledWith(detailTaskId, "2026-09-03");
    expect(setTaskPriority).toHaveBeenCalledWith(detailTaskId, 4);
  });

  // Issue #376 removed `setTaskDeadline` (no surface can set one anymore),
  // so a Task carrying a restored `deadline` value is included here only
  // to prove the rename path still tolerates it without throwing — not
  // because anything could still act on it.
  it("leaves an existing Date, Priority and Labels untouched when a rename contains no recognised phrase", async () => {
    const renameTask = vi.fn();
    const setTaskDate = vi.fn();
    const setTaskPriority = vi.fn();
    const setTaskLabels = vi.fn();
    renderTodoPage(
      inboxContext(
        [
          task({
            id: "a",
            content: "buy milk",
            date: "2026-09-10",
            deadline: "2026-09-15",
            priority: 3,
            labelIds: ["label-existing"],
          }),
        ],
        { renameTask, setTaskDate, setTaskPriority, setTaskLabels },
      ),
    );

    await waitFor(() => expect(screen.getByText("buy milk")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
    const editor = await screen.findByLabelText("Task name");
    fireEvent.change(editor, { target: { value: "buy oat milk" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(renameTask).toHaveBeenCalledWith("a", "buy oat milk"));
    expect(setTaskDate).not.toHaveBeenCalled();
    expect(setTaskPriority).not.toHaveBeenCalled();
    expect(setTaskLabels).not.toHaveBeenCalled();
  });
});

// Issue #169: `view="today"` is the same lazy chunk rendering a second,
// co-equal view over the same Tasks — TodoPage's own doc comment on its
// `view` prop explains why this is a prop rather than a second page
// module.
describe("TodoPage — Today", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 2, 12, 0)); // Sep 2, 2026, local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders Today's own content instead of Inbox's list", () => {
    renderTodoPage(
      readyContext({ tasks: [task({ id: "a", content: "call mum", date: "2026-09-02" })] }),
      "/todo/today",
    );

    expect(screen.getByText("Due today (1)")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in your Inbox/)).not.toBeInTheDocument();
  });

  it("still offers the Add form and Todo's own nav from Today", () => {
    renderTodoPage(readyContext(), "/todo/today");

    // The quiet "Add task" trigger button, not the editor itself: this
    // describe block runs under fake timers (this file's own `beforeEach`
    // above), and the editor only mounts (behind a `React.lazy` boundary,
    // `add-task-form.tsx`'s own header comment) once that button is
    // clicked and revealed — the collapsed trigger itself is always
    // present synchronously, which is all "still offers the Add form"
    // needs.
    expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Todo" })).toBeInTheDocument();
  });

  it("reads a fully clear Today as an achievement", () => {
    renderTodoPage(readyContext({ tasks: [] }), "/todo/today");

    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("completing a Task from Today raises the same Undo toast Inbox does", () => {
    const completeTask = vi.fn();
    renderTodoPage(
      readyContext({
        tasks: [task({ id: "a", content: "call mum", date: "2026-09-02" })],
        completeTask,
      }),
      "/todo/today",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as complete" }));

    expect(completeTask).toHaveBeenCalledWith("a");
    expect(toast.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ duration: 10_000 }),
    );
  });
});

// Issue #169: the schedule sheet is one instance shared by every view
// (todo-page.tsx's own doc comment on `schedulingId`) — exercised once
// from Inbox here, since task-schedule-sheet.test.tsx already covers the
// sheet's own picker behaviour in isolation. Issue #253 moved Date off
// this sheet onto its own per-row anchored `TaskSchedulePopover` instance
// (task-row-content.tsx) — the row's hover Date button opens that instead
// now, so this describe block exercises the sheet through the
// More-actions "Deadline…" item instead, the door that still reaches it.
describe("TodoPage — scheduling", () => {
  // Issue #376 removed the More-actions "Deadline…" item that used to
  // open this sheet from Inbox — `Y` (Priority) is the only door left, so
  // that's what this test uses to reach it now.
  it("closing the sheet leaves no Task being scheduled", async () => {
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })]));

    const title = await screen.findByRole("button", { name: "call mum" });
    title.focus();
    fireEvent.keyDown(document, { key: "y" });
    // `LazyTaskScheduleSheet` resolves its `import()` asynchronously
    // (lazy-task-schedule-sheet.ts's own header comment) — wait for the
    // dialog to actually mount before dismissing it.
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByText('Schedule "call mum"')).not.toBeInTheDocument());
  });
});

// Issue #253: the row's hover Date button, the More-actions "Date…" item
// and the `T` shortcut all open the SAME per-row anchored
// `TaskSchedulePopover` instance rather than the shared sheet — exercised
// once from Inbox here (task-row.test.tsx already covers the fan-in in
// isolation, and task-schedule-popover.test.tsx the popover's own
// internals), so this only proves TodoPage wires the popover's setters to
// real TaskStore mutations.
describe("TodoPage — the Date popover", () => {
  it("the hover Date button opens this row's own anchored popover, and picking a day calls setTaskDate", async () => {
    const setTaskDate = vi.fn();
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })], { setTaskDate }));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));

    expect(await screen.findByTestId("scheduler-view")).toBeInTheDocument();
    expect(screen.queryByText('Schedule "call mum"')).not.toBeInTheDocument();

    // `/^Today \w{3}$/`, not a bare `/^Today/` — react-day-picker's own
    // default aria-label for today's calendar cell also starts with
    // "Today, " (a comma and the full weekday name), which would
    // otherwise match too (found the hard way, in task-detail-view.test.tsx).
    fireEvent.click(screen.getByRole("button", { name: /^Today \w{3}$/ }));

    expect(setTaskDate).toHaveBeenCalledWith("a", expect.any(String));
  });

  it("the More-actions 'Date…' item opens the identical popover instance", async () => {
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })]));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Date/ }));

    expect(await screen.findByTestId("scheduler-view")).toBeInTheDocument();
  });
});

// Issue #171's own two new views — Projects (the list) and one Project's
// own screen, both reached through the same `TodoPage` lazy chunk
// (this file's own top comment on `renderTodoPage`).
describe("TodoPage — Projects", () => {
  it("lists every Project and adds a new one through the form", () => {
    const addProject = vi.fn();
    renderTodoPage(
      readyContext({
        projects: [
          {
            id: "p1",
            deviceId: "device-a",
            name: "Groceries",
            colour: "#DC4C3E",
            favourite: false,
            archived: false,
            parentId: null,
            description: null,
            orderKey: "A",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            seq: 1,
            syncedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        ],
        addProject,
      }),
      "/todo/projects",
    );

    expect(screen.getByRole("link", { name: "Groceries" })).toHaveAttribute(
      "href",
      "/todo/projects/p1",
    );

    fireEvent.change(screen.getByLabelText("New Project's name"), {
      target: { value: "Errands" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(addProject).toHaveBeenCalledWith(
      "Errands",
      expect.objectContaining({ colour: expect.any(String) }),
    );
  });

  it("opening a Project lists its own Tasks, reusing Inbox's own list", async () => {
    const project = {
      id: "p1",
      deviceId: "device-a",
      name: "Groceries",
      colour: "#DC4C3E",
      favourite: false,
      archived: false,
      parentId: null,
      description: null,
      orderKey: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    const projectTask = task({ id: "a", content: "buy milk", projectId: "p1" });
    renderTodoPage(
      readyContext({
        projects: [project],
        tasks: [projectTask],
        listTasksInProject: vi.fn(async (projectId: string | null) =>
          projectId === "p1" ? [projectTask] : [],
        ),
      }),
      "/todo/projects/p1",
    );

    await waitFor(() => expect(screen.getByText("buy milk")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Mark task as complete" })).toBeInTheDocument();
  });

  it("adding a Task from a Project's own view inherits that Project", async () => {
    const project = {
      id: "p1",
      deviceId: "device-a",
      name: "Groceries",
      colour: "#DC4C3E",
      favourite: false,
      archived: false,
      parentId: null,
      description: null,
      orderKey: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    const addTask = vi.fn();
    renderTodoPage(readyContext({ projects: [project], addTask }), "/todo/projects/p1");

    await revealAddTaskField();
    fireEvent.change(await screen.findByLabelText("Task name"), { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    await waitFor(() =>
      expect(addTask).toHaveBeenCalledWith(
        "buy milk",
        expect.objectContaining({ projectId: "p1" }),
      ),
    );
  });

  // Issue #370 — a typed `#project` actually files the Task (find-or-create
  // via use-projects.ts's `resolveProjectId`), and the sigil is stripped
  // from the saved title exactly like a recognised date already is.
  describe("a typed #project/section (issue #370)", () => {
    it("assigns the Task to a typed #project, and strips the sigil from the saved title", async () => {
      const addTask = vi.fn();
      const resolveProjectId = vi.fn(async (name: string) => `project-${name}`);
      // Issue #388: "Groceries" has to be a real Project the page knows
      // about for `#Groceries` to match at all — #370's own find-or-create
      // resolver only runs once the parser has recognised a `#project`
      // token in the first place.
      renderTodoPage(
        inboxContext([], {
          projects: [project({ id: "p1", name: "Groceries" })],
          addTask,
          resolveProjectId,
        }),
      );

      await revealAddTaskField();
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "buy milk #Groceries" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      await waitFor(() => expect(resolveProjectId).toHaveBeenCalledWith("Groceries"));
      expect(addTask).toHaveBeenCalledWith(
        "buy milk",
        expect.objectContaining({ projectId: "project-Groceries" }),
      );
    });

    // The ticket's own worked example: a typed `#project` beats the
    // ambient view's own Project — issue #370 gives `captureProjectId` the
    // typed override this file's own `handleAdd` comment used to say it
    // had none of. Issue #388: both "Groceries" (the ambient Project) and
    // "Work" (the typed one) have to be real Projects for either sigil to
    // match at all.
    it("a typed #project overrides the view's own inherited Project", async () => {
      const groceries = project({ id: "p1", name: "Groceries" });
      const work = project({ id: "p2", name: "Work" });
      const addTask = vi.fn();
      const resolveProjectId = vi.fn(async () => "project-work");
      renderTodoPage(
        readyContext({ projects: [groceries, work], addTask, resolveProjectId }),
        "/todo/projects/p1",
      );

      await revealAddTaskField();
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "buy milk #Work" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      await waitFor(() => expect(resolveProjectId).toHaveBeenCalledWith("Work"));
      expect(addTask).toHaveBeenCalledWith(
        "buy milk",
        expect.objectContaining({ projectId: "project-work" }),
      );
    });

    // Issue #388: `/section` only scopes against the AMBIENT Project's own
    // Section list (todo-page.tsx's own `sectionNamesByProject` doc
    // comment — a typed `#project` different from the one currently being
    // viewed has no Section list fetched for it, a known, deliberate
    // limitation, not solved by this ticket). So unlike #370's own
    // original version of this test, the typed `#project` here is the SAME
    // one the view is already open on — still exercises the real,
    // end-to-end resolve path (`resolveProjectId`/`resolveSectionId` both
    // actually called), just no longer proves an override at the same
    // time; that's `a typed #project overrides the view's own inherited
    // Project` just above's own job now.
    it("#project /section lands the Task in that Section, resolved inside the typed Project", async () => {
      const work = project({ id: "p2", name: "Work" });
      const addTask = vi.fn();
      const resolveProjectId = vi.fn(async () => "project-work");
      const resolveSectionId = vi.fn(async () => "section-cutover");
      const listSections = vi.fn(async () => [
        section({ id: "s1", projectId: "p2", name: "Cutover" }),
      ]);
      renderTodoPage(
        readyContext({
          projects: [work],
          addTask,
          resolveProjectId,
          resolveSectionId,
          listSections,
        }),
        "/todo/projects/p2",
      );

      await revealAddTaskField();
      await waitFor(() => expect(listSections).toHaveBeenCalledWith("p2"));
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "buy milk #Work /Cutover" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      await waitFor(() => expect(resolveSectionId).toHaveBeenCalledWith("project-work", "Cutover"));
      expect(addTask).toHaveBeenCalledWith(
        "buy milk",
        expect.objectContaining({ projectId: "project-work", sectionId: "section-cutover" }),
      );
    });

    // "Last one wins" (../../packages/core/src/quick-add/parse-quick-add.ts's
    // own `buildResult` comment) already collapses two `#project` tokens in
    // one line to a single `projectName` before this page ever sees it —
    // this proves the wiring doesn't call `resolveProjectId` a second time
    // on top of that, which would be the only way this page could still
    // mint a duplicate. Issue #388: both names have to be real Projects.
    it("two #project references in one line resolve only once, not twice", async () => {
      const addTask = vi.fn();
      const resolveProjectId = vi.fn(async () => "project-personal");
      renderTodoPage(
        inboxContext([], {
          projects: [project({ id: "p1", name: "Work" }), project({ id: "p2", name: "Personal" })],
          addTask,
          resolveProjectId,
        }),
      );

      await revealAddTaskField();
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "buy milk #Work #Personal" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      await waitFor(() => expect(addTask).toHaveBeenCalled());
      expect(resolveProjectId).toHaveBeenCalledTimes(1);
      expect(resolveProjectId).toHaveBeenCalledWith("Personal");
    });

    // Issue #388 changed what "ignored" means here. Inbox (the ambient
    // Project in this test) has no Sections of its own — under the
    // pre-#388 permissive parser, `/Cutover` was always RECOGNISED as a
    // section token and stripped from the title, just never resolved
    // (`projectId === null` skipped the resolve call); now that
    // `/section` only matches a real name, an unrecognised `/Cutover`
    // stays literal in the title instead of silently vanishing from it —
    // issue #388's own acceptance criterion ("an unknown name … stays in
    // the title as plain text and creates nothing").
    it("a lone /section with no typed or ambient Project is ignored", async () => {
      const addTask = vi.fn();
      const resolveSectionId = vi.fn(async () => "section-cutover");
      renderTodoPage(inboxContext([], { addTask, resolveSectionId }));

      await revealAddTaskField();
      fireEvent.change(await screen.findByLabelText("Task name"), {
        target: { value: "buy milk /Cutover" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      await waitFor(() => expect(addTask).toHaveBeenCalled());
      expect(resolveSectionId).not.toHaveBeenCalled();
      expect(addTask).toHaveBeenCalledWith(
        "buy milk /Cutover",
        expect.objectContaining({ projectId: null, sectionId: null }),
      );
    });
  });

  // Issue #297 — `ProjectStore.setProjectParent` existed, was persisted,
  // synced and rendered (`depthOf()`), but nothing in the UI ever reached
  // it: `ProjectsView`'s own create form had no way to choose a parent,
  // and `ProjectEditDialog` had no reparent field at all. These two prove
  // this page's own wiring — the `onAdd`/`onSetParent` call sites this
  // ticket added here — actually reaches the hook, not just that the
  // controls render (project-edit-dialog.test.tsx/projects-view.test.tsx
  // already cover the controls themselves in isolation).
  it("creates a Project nested under the chosen parent", () => {
    const addProject = vi.fn();
    const parent = {
      id: "p1",
      deviceId: "device-a",
      name: "Groceries",
      colour: "#DC4C3E",
      favourite: false,
      archived: false,
      parentId: null,
      description: null,
      orderKey: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    renderTodoPage(readyContext({ projects: [parent], addProject }), "/todo/projects");

    fireEvent.change(screen.getByLabelText("New Project's name"), {
      target: { value: "Sub-list" },
    });
    fireEvent.change(screen.getByLabelText("New Project's parent"), {
      target: { value: "p1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(addProject).toHaveBeenCalledWith(
      "Sub-list",
      expect.objectContaining({ parentId: "p1" }),
    );
  });

  it("reparents an existing Project through the Edit dialog, calling through to setProjectParent", async () => {
    const setProjectParent = vi.fn(async () => {});
    const groceries = {
      id: "p1",
      deviceId: "device-a",
      name: "Groceries",
      colour: "#DC4C3E",
      favourite: false,
      archived: false,
      parentId: null,
      description: null,
      orderKey: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    const work = { ...groceries, id: "p2", name: "Work" };
    renderTodoPage(
      readyContext({ projects: [groceries, work], setProjectParent }),
      "/todo/projects/p1",
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Project options menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Project parent"), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setProjectParent).toHaveBeenCalledWith("p1", "p2"));
  });
});

// Issue #185, ADR 0058 — Filters wired into TodoPage exactly the way
// Projects were: a list view (`/todo/filters`) and a single Filter's own
// screen (`/todo/filters/new`, `/todo/filters/:filterId`), both rendered
// through this same lazy chunk (this file's own header comment on the
// `view` prop). FilterView's and FiltersView's own unit tests already
// cover the grammar, the live preview, and the parse-error/Save-disabled
// behaviour in full (filter-view.test.tsx) — these three exist only to
// prove the page-level wiring: the right component mounts for the right
// route, and `addFilter`/the outlet context's other Filter setters are
// the ones actually reached.
describe("TodoPage — Filters", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10, 12, 0)); // Sep 10, 2026, local noon
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists every Filter, linking to its own screen", () => {
    renderTodoPage(
      readyContext({
        filters: [
          {
            id: "f1",
            deviceId: "device-a",
            name: "Due today",
            colour: "#DC4C3E",
            query: "today",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            seq: 1,
            syncedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        ],
      }),
      "/todo/filters",
    );

    expect(screen.getByRole("link", { name: "Due today" })).toHaveAttribute(
      "href",
      "/todo/filters/f1",
    );
  });

  it("opening a saved Filter shows its name, its query, and what it matches (criterion 1)", () => {
    renderTodoPage(
      readyContext({
        filters: [
          {
            id: "f1",
            deviceId: "device-a",
            name: "Due today",
            colour: "#DC4C3E",
            query: "today",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            seq: 1,
            syncedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        ],
        tasks: [task({ id: "a", content: "call mum", date: "2026-09-10" })],
      }),
      "/todo/filters/f1",
    );

    expect(screen.getByRole("textbox", { name: "Filter name" })).toHaveValue("Due today");
    expect(screen.getByRole("textbox", { name: "Filter query" })).toHaveValue("today");
    expect(screen.getByText("call mum")).toBeInTheDocument();
  });

  it("creating a new Filter (criterion 7's live preview, then Save) calls addFilter with the typed name and query", () => {
    const addFilter = vi.fn(() => "new-filter-id");
    renderTodoPage(readyContext({ addFilter }), "/todo/filters/new");

    fireEvent.change(screen.getByRole("textbox", { name: "Filter name" }), {
      target: { value: "My overdue" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter query" }), {
      target: { value: "overdue" },
    });

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    expect(addFilter).toHaveBeenCalledWith(
      "My overdue",
      "overdue",
      expect.objectContaining({ colour: expect.any(String) }),
    );
  });

  it("a query this grammar cannot parse keeps Save disabled and shows the error plainly (criterion 6)", () => {
    renderTodoPage(readyContext(), "/todo/filters/new");

    fireEvent.change(screen.getByRole("textbox", { name: "Filter name" }), {
      target: { value: "Bad filter" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter query" }), {
      target: { value: "today & p1 | subtask" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/parentheses/i);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

// Issue #254: Todo's app bar is gone, replaced by a real `<h1>` heading
// inside the scrollable column, pinning the view→heading mapping
// (`todoHeading`, this file's own module). jsdom lays nothing out, so this
// cannot confirm the *pixel* values (26px/700/35px) — only that the right
// text lands in a real heading, and that the app bar it replaces is gone.
// The real-browser measurement is outstanding (see the ticket's own
// verification-honesty note).
describe("TodoPage — in-column heading (issue #254)", () => {
  it("shows no separate app bar for Todo", () => {
    renderTodoPage(readyContext());

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("renders Inbox's heading as a real h1", () => {
    renderTodoPage(readyContext());

    const heading = screen.getByRole("heading", { name: "Inbox" });
    expect(heading.tagName).toBe("H1");
  });

  it("renders Today's heading", () => {
    renderTodoPage(readyContext(), "/todo/today");

    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
  });

  it("renders Upcoming's heading", () => {
    renderTodoPage(readyContext(), "/todo/upcoming");

    expect(screen.getByRole("heading", { name: "Upcoming" })).toBeInTheDocument();
  });

  it("renders a Project's own resolved name as the heading", () => {
    const project = {
      id: "p1",
      deviceId: "device-a",
      name: "Groceries",
      colour: "#DC4C3E",
      favourite: false,
      archived: false,
      parentId: null,
      description: null,
      orderKey: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    renderTodoPage(readyContext({ projects: [project] }), "/todo/projects/p1");

    expect(screen.getByRole("heading", { name: "Groceries" })).toBeInTheDocument();
  });

  it("renders a Filter's own resolved name as the heading", () => {
    const filter = {
      id: "f1",
      deviceId: "device-a",
      name: "Due today",
      colour: "#DC4C3E",
      query: "today",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    renderTodoPage(readyContext({ filters: [filter] }), "/todo/filters/f1");

    expect(screen.getByRole("heading", { name: "Due today" })).toBeInTheDocument();
  });

  it("keeps Back reachable and the Sync dot present alongside the heading", () => {
    renderTodoPage(readyContext());

    expect(screen.getByRole("link", { name: "Back to chats" })).toBeInTheDocument();
    expect(screen.getByTestId("sync-status-indicator")).toBeInTheDocument();
  });
});

// Issue #307: before this, `/todo/search` was a real route with a real page
// that nothing on a narrow viewport linked to — the bottom bar
// (todo-nav.tsx's own TODO_NAV_DESTINATIONS) carries six destinations and
// Search isn't one of them, and TodoSidebar was the only thing that ever
// did, at the breakpoint it replaced the bar at when this door was built
// (≥900px, at the time). This is the minimal door: a Search action in
// Todo's own in-column heading (shell.tsx's `hideAppBar` row, issue #254),
// reachable below the wide-layout breakpoint the same way the rest of
// Todo's chrome already keys off it. The owner's later amendment to ADR
// 0076 moved TodoSidebar's own breakpoint to 1200px without moving this
// door's — the "TodoPage — sidebar column" describe block below has the
// gap that leaves and why this describe block's own gate stays put.
//
// Pinned explicitly here rather than left to apps/web/src/test/setup.ts's
// own ambient stub (which already answers `false` for every query but
// `(hover: hover)`, so every test elsewhere in this file already runs
// "narrow" by coincidence) — a test whose own claim is about a breakpoint
// has to set that breakpoint itself, not merely happen to run under
// whatever the global default is today.
function installNarrowMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

// Query-aware, unlike a blunt "true for everything" stub: this page now
// also reads `TODO_SIDEBAR_QUERY` (`sidebarWide`, for the sidebar column
// below), a narrower, independent query from `WIDE_LAYOUT_QUERY` — a test
// asserting the Search door's own 900px claim has to leave that second
// query unanswered (false), or it would incidentally also mount
// `LazyTodoSidebar` and start proving something this describe block was
// never about.
function installWideMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((query: string) => ({
      matches: query === WIDE_LAYOUT_QUERY,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

// Both queries match: a 1200px+ window is, by construction, also a 900px+
// one. Used only by the sidebar-column tests below, which are the one
// place in this file that wants `LazyTodoSidebar` to actually mount.
function installSidebarWideMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((query: string) => ({
      matches: query === WIDE_LAYOUT_QUERY || query === TODO_SIDEBAR_QUERY,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });
}

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("TodoPage — Search door (issue #307)", () => {
  afterEach(removeMatchMedia);

  it("below the 900px wide-layout breakpoint, offers a real link to /todo/search at least 48 CSS px on a side", () => {
    installNarrowMatchMedia();
    renderTodoPage(readyContext(), "/todo/inbox");

    const link = screen.getByRole("link", { name: "Search" });
    expect(link).toHaveAttribute("href", "/todo/search");
    // `size-12` is Tailwind's 3rem/48px utility — the acceptance criterion's
    // own floor, and the exact number `back-to-chats.tsx`'s own `size-11`
    // (44px) comment already documents this app's app-bar icon controls by.
    // jsdom lays nothing out, so this is a source-level check that the
    // class is the one which resolves to 48px, not a live pixel measurement
    // — the real-browser measurement is the parent's own device pass.
    expect(link.className).toContain("size-12");
  });

  it("renders in the 900-1199px band, where TodoSidebar is not mounted to reach Search", () => {
    installWideMatchMedia();
    renderTodoPage(readyContext(), "/todo/inbox");

    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("href", "/todo/search");
  });

  // The other side of the same gate, and the half that was never covered:
  // once `TodoSidebar` IS mounted it carries its own `/todo/search` link,
  // so a second door here would be the duplicate affordance this gate has
  // always existed to prevent.
  it("renders nothing once TodoSidebar is mounted at 1200px", async () => {
    installSidebarWideMatchMedia();
    openEntryStoreMock.mockResolvedValue({
      taskStore: { list: () => Promise.resolve([]) },
      projectStore: { listProjects: () => Promise.resolve([]) },
      filterStore: { list: () => Promise.resolve([]) },
    });
    renderTodoPage(readyContext(), "/todo/inbox");

    // Must WAIT for `LazyTodoSidebar`'s dynamic import, exactly as the
    // "sidebar column" block below does — its Suspense fallback is `null`,
    // so a synchronous read here sees no sidebar, no Search link, and no
    // "Todo" landmark at all, and an absence assertion would pass for that
    // reason rather than the intended one.
    await screen.findByRole("link", { name: "Reporting" }, { timeout: 5000 });

    // Assert the COUNT, not absence. "The header door is gone" and
    // "nothing links Search at all" are different outcomes and only one is
    // correct; a bare `queryBy(...).not.toBeInTheDocument()` passes for
    // both, which is precisely how the 900-1199px gap went unnoticed.
    const doors = screen.getAllByRole("link", { name: "Search" });
    expect(doors).toHaveLength(1);
    expect(
      within(screen.getByRole("navigation", { name: "Todo" })).getByRole("link", {
        name: "Search",
      }),
    ).toBe(doors[0]);
  });

  it("does not offer the door a second time while already standing on the Search page itself", () => {
    installNarrowMatchMedia();
    renderTodoPage(readyContext(), "/todo/search");

    expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Search" })).not.toBeInTheDocument();
  });

  // The acceptance criterion this proves: "reaching Search and going back
  // returns the reader where they were." `GoBackProbe` (this file's own
  // helper, mirroring composer-page.test.tsx's and
  // digest-reader-page.test.tsx's identical stand-ins) drives `navigate(-1)`
  // — the same mechanism a real hardware Back press resolves to
  // (back-button.android.ts's own `window.history.back()`) once
  // use-back-button.ts's depth counter says there's somewhere to go back
  // to. That depends on the door being a real push navigation, not a
  // `replace` — the identical shape `openFullSearch` (todo-page.tsx) already
  // uses for Quick-find's "Show more results".
  it("reaching Search from Today and going back returns to Today, not the root", () => {
    installNarrowMatchMedia();
    renderTodoPage(readyContext(), "/todo/today");
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Search" }));
    expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Simulate Back" }));
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Search" })).not.toBeInTheDocument();
  });
});

// Issue #353, ADR 0086 ("Todo's own views are interior state, not
// departures") — the follow-up ADR 0079 named explicitly and left undone:
// moving between Todo's own views must not push a history entry, and the
// Task detail's own address is the one deliberate exception (a modal is
// something a reader dismisses, not a screen they leave). These prove the
// three shapes ADR 0079's own Consequences section named — a real Back
// press after visiting several interior views, a real Back press
// dismissing the one interior navigation that still earns a history
// entry, and closing that same navigation with nothing behind it to pop.
describe("TodoPage — Back leaves Todo, not walks its views (issue #353, ADR 0086)", () => {
  afterEach(removeMatchMedia);

  // A real uuid, mirroring the main describe block's own `DETAIL_TASK_ID`
  // — `taskIdFromParam`'s regex (lib/task-detail-route.ts) only ever reads
  // the trailing uuid, so a plain `"a"` id wouldn't resolve to anything,
  // whether reached by a row click or a direct link.
  const DETAIL_TASK_ID = "22222222-2222-7222-8222-222222222222";

  it("visiting several Todo views then pressing Back once leaves Todo", () => {
    installNarrowMatchMedia();
    // Entering Todo from the root screen is itself a real push — the one
    // entry a Back press has to pop past to actually leave Todo.
    // `["/composer", "/todo/inbox"]` puts it there, the same "opened from
    // the cards" shape digest-reader-page.test.tsx's own stepping test
    // uses to prove the identical rule for Digest.
    renderTodoPage(readyContext(), "/todo/inbox", ["/composer", "/todo/inbox"]);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Todo" });
    fireEvent.click(within(nav).getByRole("link", { name: "Today" }));
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole("link", { name: "Upcoming" }));
    expect(screen.getByRole("heading", { name: "Upcoming" })).toBeInTheDocument();

    // A single Back, after visiting three of Todo's own views (Inbox,
    // Today, Upcoming), leaves Todo outright — each row's `replace`
    // (`todo-nav.tsx`) means none of the moves between them grew the
    // history stack, so the only real entry to pop is the one that
    // entered Todo in the first place.
    fireEvent.click(screen.getByRole("button", { name: "Simulate Back" }));

    expect(screen.getByText("Composer")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Todo" })).not.toBeInTheDocument();
  });

  it("Back with a Task detail open closes it and reveals the list underneath; a second Back leaves Todo", async () => {
    renderTodoPage(
      inboxContext([task({ id: DETAIL_TASK_ID, content: "call mum" })]),
      "/todo/inbox",
      ["/composer", "/todo/inbox"],
    );
    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());

    // Opening the Task from its row is `openTaskDetail`'s real push (kept
    // exactly as it was — ADR 0086's deliberate exception), so there is a
    // real entry for Back to pop.
    fireEvent.click(screen.getByText("call mum"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // First Back closes the Task detail rather than leaving Todo — a
    // modal is dismissed, not walked out of, and popping its own entry
    // lands exactly back on the list it opened over. `hidden: true` —
    // Radix's own Dialog marks this background button `aria-hidden` while
    // open (composer-page.test.tsx's own identical comment on the same
    // gap); the click still fires on the real DOM node regardless of what
    // the accessibility tree currently exposes.
    fireEvent.click(screen.getByRole("button", { name: "Simulate Back", hidden: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Todo" })).toBeInTheDocument();
    expect(screen.getByText("call mum")).toBeInTheDocument();

    // Second Back leaves Todo for the root screen.
    fireEvent.click(screen.getByRole("button", { name: "Simulate Back" }));
    expect(screen.getByText("Composer")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Todo" })).not.toBeInTheDocument();
  });

  it("closing a Task detail opened by direct link, with no history behind it, still lands on the background rather than doing nothing", async () => {
    renderTodoPage(
      inboxContext([task({ id: DETAIL_TASK_ID, content: "call mum" })]),
      `/todo/task/call-mum-${DETAIL_TASK_ID}`,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    // A single-entry stack — `location.key === "default"` — the same
    // "bookmark, shared link, or reload" case `closeTaskDetail`'s own
    // comment names. `navigate(-1)` has nothing to pop here, so a Back
    // press aimed at this dialog has to fall back to a real `replace`
    // navigation instead of doing nothing.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/todo/inbox");
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });
});

describe("TodoPage — Browse", () => {
  afterEach(removeMatchMedia);

  it("renders Browse's own hub, scoped to its own landmark, when the view is browse", () => {
    installNarrowMatchMedia();
    renderTodoPage(readyContext(), "/todo/browse");

    expect(screen.getByRole("heading", { name: "Browse" })).toBeInTheDocument();
    const browseNav = screen.getByRole("navigation", { name: "Browse" });
    expect(within(browseNav).getByRole("link", { name: "Filters & Labels" })).toHaveAttribute(
      "href",
      "/todo/filters",
    );
    expect(within(browseNav).getByRole("link", { name: "Reporting" })).toHaveAttribute(
      "href",
      "/todo/activity",
    );
    expect(within(browseNav).getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      "/todo/projects",
    );
  });

  // Browse is a hub of links, not a Task list — the identical reason
  // Projects/Filters/Activity/Labels/Upcoming already get no inline
  // composer (this page's own guard, just above the view switch).
  it("offers no inline Add-task composer on Browse", () => {
    installNarrowMatchMedia();
    renderTodoPage(readyContext(), "/todo/browse");

    expect(screen.queryByRole("button", { name: "Add task" })).not.toBeInTheDocument();
  });

  // The regression this closes: between 900 and 1199px, before ADR 0084,
  // nothing linked `/todo/search` at all. BOTH doors are on screen here —
  // Browse's own row and the header door, whose gate now tracks the
  // sidebar rather than the pane — so a bare `getByRole` would throw on
  // two matches. That ambiguity is the owner's "keep both doors" ruling
  // working, not a defect: asserting the COUNT is what proves the band has
  // two ways to Search rather than the one it shipped with.
  it("closes the 900-1199px Search gap, with both doors on screen", () => {
    installWideMatchMedia();
    renderTodoPage(readyContext(), "/todo/browse");

    const doors = screen.getAllByRole("link", { name: "Search" });
    expect(doors).toHaveLength(2);
    for (const door of doors) {
      expect(door).toHaveAttribute("href", "/todo/search");
    }
  });

  // Constraint #5 (the owner's ruling): meologue keeps BOTH the header
  // Search door and Browse's own row, even though real Todoist Android
  // has only the one. Below 900px, with Browse open, both are on screen
  // at once — a bare `getByRole("link", { name: "Search" })` here throws
  // on more than one match, so this proves the ambiguity is real AND that
  // scoping each to its own landmark resolves it, rather than either
  // ignoring the second match or deleting a door to make the collision go
  // away.
  it("keeps both Search doors on screen at once below 900px while Browse is open", () => {
    installNarrowMatchMedia();
    renderTodoPage(readyContext(), "/todo/browse");

    const searchLinks = screen.getAllByRole("link", { name: "Search" });
    expect(searchLinks).toHaveLength(2);

    const browseNav = screen.getByRole("navigation", { name: "Browse" });
    expect(within(browseNav).getByRole("link", { name: "Search" })).toHaveAttribute(
      "href",
      "/todo/search",
    );

    // The header door is the one Search link NOT inside Browse's own
    // landmark.
    const headerDoor = searchLinks.find((link) => !browseNav.contains(link));
    expect(headerDoor).toHaveAttribute("href", "/todo/search");
  });
});

/**
 * The owner's amendment to ADR 0076: `TodoSidebar` is a second column
 * inside this page's own subtree, gated on `sidebarWide` (1200px), not
 * `wide` (900px). "Reporting" — `TodoSidebar`'s own wording for
 * `/todo/activity` (`todo-nav-destinations.ts`'s own header comment: the
 * two navigations are free to word a shared destination differently) — is
 * this describe block's marker for "the sidebar, specifically, is on
 * screen": `TodoNav` labels the identical route "Activity" and renders
 * only when the sidebar does not (todo-nav.tsx's own duplicate-landmark
 * reasoning), so the two never collide and "Reporting" can only ever come
 * from `TodoSidebar`.
 */
describe("TodoPage — sidebar column (owner's amendment to ADR 0076)", () => {
  afterEach(removeMatchMedia);

  it("does not mount TodoSidebar below 1200px, even though the chat-list breakpoint (900px) already matches", () => {
    installWideMatchMedia();
    renderTodoPage(readyContext(), "/todo/inbox");

    expect(screen.queryByRole("link", { name: "Reporting" })).not.toBeInTheDocument();
  });

  it("mounts TodoSidebar as a second column at 1200px", async () => {
    installSidebarWideMatchMedia();
    openEntryStoreMock.mockResolvedValue({
      taskStore: { list: () => Promise.resolve([]) },
      projectStore: { listProjects: () => Promise.resolve([]) },
      filterStore: { list: () => Promise.resolve([]) },
    });
    renderTodoPage(readyContext(), "/todo/inbox");

    // Real timers throughout this file (no `vi.useFakeTimers()`) —
    // `React.lazy`'s own dynamic import resolving, `entryStoreQueryOptions`'s
    // promise, and the three dependent Tasks/Projects/Filters queries it
    // unlocks all settle over several real microtask/timer hops TanStack
    // Query schedules internally; `findByRole` polls for exactly that. A
    // longer-than-default timeout: this is the one test in this file
    // actually paying for `React.lazy`'s own dynamic `import()`, which the
    // default 1000ms sometimes outruns even though the resolution itself
    // never fails (chat-shell-layout.test.tsx's own former copy of this
    // test recorded the identical timing before the mount point moved
    // here).
    expect(
      await screen.findByRole("link", { name: "Reporting" }, { timeout: 5000 }),
    ).toHaveAttribute("href", "/todo/activity");
  });
});

// Issue #352: opening Todo returns the reader to the view they were last
// on rather than always Inbox — `lib/last-todo-view.ts`'s own header
// comment has the storage-choice reasoning; this describe block covers
// the two halves that live on this page: recording `backgroundView`
// (below) and, via `renderTodoPage`'s own bare `/todo` route (added for
// this ticket, mirroring App.tsx's real one), resolving it back.
describe("TodoPage — remembers the last view (issue #352)", () => {
  beforeEach(() => {
    clearLastTodoView();
  });

  afterEach(() => {
    clearLastTodoView();
  });

  const project = {
    id: "p1",
    deviceId: "device-a",
    name: "Groceries",
    colour: "#DC4C3E",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "A",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };

  const filter = {
    id: "f1",
    deviceId: "device-a",
    name: "Due today",
    colour: "#DC4C3E",
    query: "today",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    syncedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };

  it.each([
    ["/todo/inbox", { view: "inbox" }],
    ["/todo/today", { view: "today" }],
    ["/todo/upcoming", { view: "upcoming" }],
    ["/todo/projects", { view: "projects" }],
    ["/todo/filters", { view: "filters" }],
    ["/todo/labels", { view: "labels" }],
    ["/todo/activity", { view: "activity" }],
    ["/todo/browse", { view: "browse" }],
  ] as const)("records %s as the last view", (path, expected) => {
    renderTodoPage(readyContext(), path);

    expect(readLastTodoView()).toEqual(expected);
  });

  it("records a specific Project, by id", () => {
    renderTodoPage(readyContext({ projects: [project] }), "/todo/projects/p1");

    expect(readLastTodoView()).toEqual({ view: "project", projectId: "p1" });
  });

  it("records a specific Filter, by id", () => {
    renderTodoPage(readyContext({ filters: [filter] }), "/todo/filters/f1");

    expect(readLastTodoView()).toEqual({ view: "filter", filterId: "f1" });
  });

  it("never records Todo's Search screen", () => {
    writeLastTodoView({ view: "today" });

    renderTodoPage(readyContext(), "/todo/search");

    expect(readLastTodoView()).toEqual({ view: "today" });
  });

  it("never records a Task detail address, even though a real view renders behind it", () => {
    writeLastTodoView({ view: "today" });

    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })]), "/todo/task/call-mum-a");

    expect(readLastTodoView()).toEqual({ view: "today" });
  });

  it("resolves a bare /todo to nothing remembered as Inbox", () => {
    renderTodoPage(readyContext(), "/todo");

    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });

  it("resolves a bare /todo to a remembered Today", () => {
    writeLastTodoView({ view: "today" });

    renderTodoPage(readyContext(), "/todo");

    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
  });

  it("resolves a bare /todo to a remembered Upcoming", () => {
    writeLastTodoView({ view: "upcoming" });

    renderTodoPage(readyContext(), "/todo");

    expect(screen.getByRole("heading", { name: "Upcoming" })).toBeInTheDocument();
  });

  it("returns to a specific Project after leaving Todo and coming back", () => {
    const away = renderTodoPage(readyContext({ projects: [project] }), "/todo/projects/p1");
    expect(readLastTodoView()).toEqual({ view: "project", projectId: "p1" });
    away.unmount();

    renderTodoPage(readyContext({ projects: [project] }), "/todo");

    expect(screen.getByRole("heading", { name: "Groceries" })).toBeInTheDocument();
  });

  it("returns to a specific Filter after leaving Todo and coming back", () => {
    const away = renderTodoPage(readyContext({ filters: [filter] }), "/todo/filters/f1");
    expect(readLastTodoView()).toEqual({ view: "filter", filterId: "f1" });
    away.unmount();

    renderTodoPage(readyContext({ filters: [filter] }), "/todo");

    expect(screen.getByRole("heading", { name: "Due today" })).toBeInTheDocument();
  });

  it("falls back to Inbox when the remembered Project has since been deleted", () => {
    writeLastTodoView({ view: "project", projectId: "gone" });

    renderTodoPage(readyContext({ projects: [] }), "/todo");

    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });

  it("falls back to Inbox when the remembered Filter has since been deleted", () => {
    writeLastTodoView({ view: "filter", filterId: "gone" });

    renderTodoPage(readyContext({ filters: [] }), "/todo");

    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });
});
