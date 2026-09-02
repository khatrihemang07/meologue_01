import type { Task } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDayKey } from "@/components/date-picker-sheet";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { TodoPage } from "./todo-page";

// `toast` is both callable (the Undo toast, todo-page.tsx's own
// `handleComplete`) and carries an `.error` method (task-tree.tsx's own
// reparent-refused toast, issue #171) — mirroring history.test.tsx's own
// `vi.mock("sonner", ...)` shape rather than the plain-callable one this
// file used before #171 ever called `toast.error`.
vi.mock("sonner", () => {
  const toast = vi.fn() as unknown as typeof import("sonner").toast;
  // biome-ignore lint/suspicious/noExplicitAny: attaching a mock method to a mock function, the same shape sonner's own `toast` carries in production (a callable object with `.error`/`.success` etc as properties).
  (toast as any).error = vi.fn();
  return { toast };
});

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
            <Route path="/todo/projects" element={<TodoPage view="projects" />} />
            <Route path="/todo/projects/:projectId" element={<TodoPage view="project" />} />
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
    removeTask: vi.fn(),
    setTaskDate: vi.fn(),
    setTaskDeadline: vi.fn(),
    setTaskDuration: vi.fn(),
    setTaskPriority: vi.fn(),
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

    // jsdom lays nothing out — `getBoundingClientRect` is always zero
    // (`history.tsx`'s own comment names the identical gap) — so the drop
    // geometry `task-tree.tsx` reads off real row rects needs a stand-in
    // here. Each row's rect is derived purely from its position among its
    // DOM siblings, which is all `dropIndexForPointer` ever looks at.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const siblings = this.parentElement ? Array.from(this.parentElement.children) : [];
      const index = siblings.indexOf(this);
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

  it("reads an empty Inbox as a real state, not a blank panel", () => {
    renderTodoPage(inboxContext([]));

    expect(screen.getByText(/Nothing in your Inbox/)).toBeInTheDocument();
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

    fireEvent.change(screen.getByLabelText("Add a Task"), { target: { value: "call mum" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // handleAdd (todo-page.tsx) awaits resolveLabelIds before calling
    // addTask — issue #170's own async label-resolution step, invisible
    // here since "call mum" carries no `%label` token to resolve, but
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

    fireEvent.change(screen.getByLabelText("Add a Task"), { target: { value: "call mum" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

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

    fireEvent.change(screen.getByLabelText("Add a Task"), {
      target: { value: "call mum tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(addTask).toHaveBeenCalled());
    const [content, overrides] = addTask.mock.calls[0] as [string, { date: string | null }];
    expect(content).toBe("call mum");
    expect(overrides.date).not.toBe(localDayKey(new Date()));
  });

  it("disables the Add form while the store isn't ready", () => {
    renderTodoPage(readyContext({ disabled: true }));

    expect(screen.getByLabelText("Add a Task")).toBeDisabled();
  });

  // The completion toast mirrors register-service-worker.web.ts's own
  // `toast(..., { action: { label, onClick } })` shape — this is the
  // Undo affordance the ticket's own brief points at.
  it("completes a Task and offers an Undo toast wired to uncompleteTask", async () => {
    const completeTask = vi.fn();
    const uncompleteTask = vi.fn();
    renderTodoPage(
      inboxContext([task({ id: "a", content: "call mum" })], { completeTask, uncompleteTask }),
    );

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "call mum" }));

    expect(completeTask).toHaveBeenCalledWith("a");
    expect(toast).toHaveBeenCalledWith(
      'Completed "call mum"',
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo", onClick: expect.any(Function) }),
      }),
    );

    const toastCall = vi.mocked(toast).mock.calls[0];
    const action = toastCall?.[1]?.action as { onClick: () => void } | undefined;
    action?.onClick();
    expect(uncompleteTask).toHaveBeenCalledWith("a");
  });

  it("restores a completed Task from the durable Completed section, independent of any toast", () => {
    const uncompleteTask = vi.fn();
    renderTodoPage(
      readyContext({
        completedTasks: [
          task({ id: "a", content: "call mum", completedAt: "2026-01-02T00:00:00.000Z" }),
        ],
        uncompleteTask,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: 'Restore "call mum"' }));

    expect(uncompleteTask).toHaveBeenCalledWith("a");
  });

  it("deletes a Task only after confirming, mirroring sessions-page.tsx's ConfirmDialog", async () => {
    const removeTask = vi.fn();
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })], { removeTask }));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Delete "call mum"' }));
    expect(removeTask).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(removeTask).toHaveBeenCalledWith("a");
  });

  it("cancelling the delete confirmation leaves the Task untouched", async () => {
    const removeTask = vi.fn();
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })], { removeTask }));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Delete "call mum"' }));
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

    expect(screen.getByLabelText("Add a Task")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("checkbox", { name: "call mum" }));

    expect(completeTask).toHaveBeenCalledWith("a");
    expect(toast).toHaveBeenCalledWith(
      'Completed "call mum"',
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
  });
});

// Issue #169: the schedule sheet is one instance shared by every view
// (todo-page.tsx's own doc comment on `schedulingId`) — exercised once
// from Inbox here, since task-schedule-sheet.test.tsx already covers the
// sheet's own picker behaviour in isolation.
describe("TodoPage — scheduling", () => {
  it("opens the schedule sheet for the tapped Task, and a picker action calls the context's setter", async () => {
    const setTaskPriority = vi.fn();
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })], { setTaskPriority }));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Schedule "call mum"' }));
    expect(screen.getByText('Schedule "call mum"')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "P1" }));

    // storedPriorityOf(1) === 4.
    expect(setTaskPriority).toHaveBeenCalledWith("a", 4);
  });

  it("closing the sheet leaves no Task being scheduled", async () => {
    renderTodoPage(inboxContext([task({ id: "a", content: "call mum" })]));

    await waitFor(() => expect(screen.getByText("call mum")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Schedule "call mum"' }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByText('Schedule "call mum"')).not.toBeInTheDocument();
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
    // The identical row markup Inbox renders — a real checkbox naming the
    // Task's own words, not a second, Project-specific list component.
    expect(screen.getByRole("checkbox", { name: "buy milk" })).toBeInTheDocument();
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
      seq: 1,
      syncedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    const addTask = vi.fn();
    renderTodoPage(readyContext({ projects: [project], addTask }), "/todo/projects/p1");

    fireEvent.change(screen.getByLabelText("Add a Task"), { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(addTask).toHaveBeenCalledWith(
        "buy milk",
        expect.objectContaining({ projectId: "p1" }),
      ),
    );
  });
});
