import type { Comment, Event, Task } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDayKey } from "@/lib/local-day-key";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { TodoPage } from "./todo-page";

// `toast` is callable (task-tree.tsx's reparent-refused toast, issue #171,
// via `.error`) and, since CMT-04, also carries a `.custom` and a
// `.dismiss` — `raiseCompletionToast` (todo-page.tsx) switched its Undo
// toast from plain `toast(message, {...})` to `toast.custom(jsx, {...})`
// so the toast's own JSX can carry `role="alert"`/`aria-live="polite"`
// (completion-toast.tsx's own header comment has the full reasoning; no
// `role` option exists anywhere in sonner 2.0.8). `.custom`'s mock returns
// an incrementing id — the same id `toast.custom` hands its `jsx`
// callback in production — so a test can call the captured `jsx` factory
// itself to get the real `CompletionToastBody` element and render it, and
// `.dismiss` records the id `raiseCompletionToast`'s Undo handler closes.
vi.mock("sonner", () => {
  const toast = vi.fn() as unknown as typeof import("sonner").toast;
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

/**
 * Issue #260: `AddTaskForm` is collapsed by default (NAV-12, parity
 * ledger) — every test that used to type straight into an always-open
 * field now has to click the quiet "Add task" trigger row first. Scoped
 * to nothing in particular because `QuickAddDialog` (also rendered by
 * `TodoPage`, unconditionally) stays unmounted by Radix while `open` is
 * false, so there is exactly one "Add task"-named button in the tree
 * until this click reveals the editor.
 */
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
function renderTodoPage(context: EntryStoreOutletContext, initialPath = "/todo/inbox") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        {/* A real link to a non-`/todo/*` route (ADR 0049's own suggested
            test shape: "navigate to `/composer` ... through the router") —
            TodoPage itself has no reason to link to Composer, so this is the
            test's own way out, not a control this ticket adds to the page. */}
        <Link to="/composer">Leave Todo</Link>
        <Routes>
          <Route element={<Outlet context={context} />}>
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
    setTaskDeadline: vi.fn(),
    setTaskPriority: vi.fn(),
    setTaskDateString: vi.fn(),
    setTaskLabels: vi.fn(),
    setTaskDescription: vi.fn(),
    listTasksInProject: vi.fn(async () => []),
    listTaskChildren: vi.fn(async () => []),
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
    // Issue #225: the title is a non-editable display element at rest
    // (DET-02) — a plain `<div>`, as Todoist's is, not a labelled textbox —
    // until a reader activates it (task-detail-view.test.tsx's own suite
    // covers that activation and the shared editor it swaps in).
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
    // Issue #237: `.completed-task-text` is the shared class the
    // completed-style setting drives (index.css) — `line-through` was the
    // bug this surface used to hardcode regardless of that setting. The
    // at-rest title is a plain display `<div>` (DET-02), found by its testid.
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

  // Issue #306: a Task row's comment badge now links with `?intent=reply`
  // (ROW-08, task-row-content.tsx) so activating it lands the reader "in
  // the thread, ready to reply" rather than merely on the Task — the
  // acceptance criteria this describe block works through one at a time.
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

  // ROW-14 (parity-ledger.md), the user's 2026-09-13 decision to match
  // Todoist: an Inbox holding only a completed Task is not the same thing
  // as an empty one — this used to be indistinguishable, since the old
  // "Completed (n)" disclosure lived below `TaskList`'s own empty-state
  // paragraph regardless of what was inside it.
  it("does not read Inbox as empty when it holds only a completed Task", () => {
    renderTodoPage(
      inboxContext([], {
        completedTasks: [
          task({ id: "a", content: "done already", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
    );

    expect(screen.queryByText(/Nothing in your Inbox/)).not.toBeInTheDocument();
    expect(screen.getByText("done already")).toBeInTheDocument();
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

  // CMT-04 (parity ledger): the completion toast is raised through
  // `toast.custom()` (`raiseCompletionToast`, todo-page.tsx —
  // completion-toast.tsx's own header comment has the full reasoning), so
  // this asserts against the real `CompletionToastBody` element the `jsx`
  // callback produces — a `role="alert"` element containing the message
  // and a real "Undo" `<button>` — rather than against `toast`'s call
  // args the way the old plain-`toast()` shape allowed.
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
        // CMT-05: 10s, measured live (`COMPLETION_TOAST_DURATION_MS`'s own
        // doc comment, todo-page.tsx) — not sonner's unconfigured default.
        duration: 10_000,
      }),
    );

    const customCall = vi.mocked(toast.custom).mock.calls[0];
    if (!customCall) throw new Error("toast.custom was not called");
    const [jsxFactory] = customCall;
    render(jsxFactory("toast-a"));

    const alertToast = screen.getByRole("alert");
    // CMT-04: Todoist's own task-agnostic, count-based wording, not the
    // task-specific `Completed "<name>"` this replaced.
    expect(alertToast).toHaveTextContent("1 task completed");

    fireEvent.click(within(alertToast).getByRole("button", { name: "Undo" }));
    expect(uncompleteTask).toHaveBeenCalledWith("a");
    // The Undo click has to dismiss the toast itself now (completion-toast.tsx's
    // own header comment) — sonner's own `action` button did this for free;
    // a bare custom button does not.
    expect(toast.dismiss).toHaveBeenCalledWith("toast-a");
  });

  // CMT-05 (parity ledger) — `Z`/`⌘Z` reach the identical `uncompleteTask`
  // call the toast's own "Undo" button already used above, through
  // `todo-page.tsx`'s pending-undo ref rather than a second undo
  // mechanism. `toast` is mocked (this file's own header comment), so
  // there is no real toast to auto-close mid-test — these three cover the
  // ref's own lifecycle: set on completion, fired once by either key, and
  // silent when nothing is pending.
  describe("keyboard undo of a completion (CMT-05)", () => {
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

    // The highest-risk part of CMT-05: Cmd+Z inside a text field must stay
    // native text-undo, not reach through to an unrelated completion. The
    // Add-task field stubs to a plain `<input>` in this suite
    // (`StubTaskTitleEditor`'s own header comment on why — jsdom can't
    // usefully mount the real ProseMirror editor), which is also exactly
    // the surface `use-todo-keymap.test.tsx`'s own CMT-05 tests note: a
    // jsdom `<input>`/`<textarea>` exercises `isTypingTarget`'s tag-check
    // arm; its `isContentEditable` arm (the real composer) is verified on
    // screen only, jsdom not implementing that property at all.
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

  // ROW-14 (parity-ledger.md), the user's 2026-09-13 decision to match
  // Todoist: a completed Task no longer lives behind a separate, durable
  // "Completed" disclosure with its own Restore button — it renders
  // inline, in place, and its own checkbox (already `aria-checked="true"`,
  // `aria-label="Mark task as incomplete"`) is what un-completes it, the
  // same control an active row's checkbox already is. Independent of any
  // toast still holds: this Task's own `completedAt` is what puts it here,
  // not a pending-undo ref (`pendingUndoRef`, todo-page.tsx) that a toast
  // could have long since cleared.
  it("restores a completed Task inline, through its own checkbox, independent of any toast", () => {
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

  // ROW-06 (parity-ledger.md): flow 10's decisive test quoted Todoist's
  // own delete-confirmation dialog as "The ZZ probe bold em code task
  // will be permanently deleted." for a title verified to hold only
  // literal `**bold** _em_ `code`` characters
  // (`live-audit-dom/flow10-ROW-06-both.json`) — meologue's own dialog
  // used to quote the raw markdown verbatim instead. Only the
  // interpolated name renders through `inlineProse`; the surrounding
  // sentence is this app's own copy, not part of the Task.
  it("renders markdown in the delete confirmation's quoted title — ROW-06", async () => {
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

  it("leaves an existing Date, Deadline, Priority and Labels untouched when a rename contains no recognised phrase", async () => {
    const renameTask = vi.fn();
    const setTaskDate = vi.fn();
    const setTaskDeadline = vi.fn();
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
        { renameTask, setTaskDate, setTaskDeadline, setTaskPriority, setTaskLabels },
      ),
    );

    await waitFor(() => expect(screen.getByText("buy milk")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
    const editor = await screen.findByLabelText("Task name");
    fireEvent.change(editor, { target: { value: "buy oat milk" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(renameTask).toHaveBeenCalledWith("a", "buy oat milk"));
    expect(setTaskDate).not.toHaveBeenCalled();
    expect(setTaskDeadline).not.toHaveBeenCalled();
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
    // CMT-04: same `toast.custom()` path as Inbox's own test above —
    // rendering the produced element here would only re-check what that
    // test already covers, so this just confirms the same call shape.
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
  it("closing the sheet leaves no Task being scheduled", async () => {
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })]));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Deadline/ }));
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
    // The identical row markup Inbox renders — a real checkbox with
    // Todoist's own fixed wording (ROW-03), not a second, Project-specific
    // list component.
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
