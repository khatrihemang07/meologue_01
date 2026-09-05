import type { Task } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskTree } from "./task-tree";

vi.mock("sonner", () => {
  const toast = vi.fn() as unknown as typeof import("sonner").toast;
  // biome-ignore lint/suspicious/noExplicitAny: attaching a mock method to a mock function — see todo-page.test.tsx's identical comment.
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
    dayOrder: "V",
    // Issue #196: updatedAt starts equal to createdAt
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

function renderTree(overrides: Partial<Parameters<typeof TaskTree>[0]> = {}) {
  const props: Parameters<typeof TaskTree>[0] = {
    tasks: [task()],
    depth: 1,
    projectId: null,
    detailActions: {
      projects: [],
      labels: [],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
    reorderTask: vi.fn(),
    setTaskParent: vi.fn(async () => {}),
    listTaskChildren: vi.fn(async () => []),
    listTasksInProject: vi.fn(async () => []),
    ...overrides,
  };
  const queryClient = new QueryClient();
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <ul>
          <TaskTree {...props} />
        </ul>
      </QueryClientProvider>,
    ),
    props,
  };
}

/** Every row this stub gives a rect is `ROW_HEIGHT` tall, stacked with no gaps — todo-page.test.tsx's own identical fixture, reused here for the same reason: `dropIndexForPointer` only ever looks at a row's position among its DOM siblings. */
const ROW_HEIGHT = 40;

/** The grip handle inside the row that renders `label`. */
function dragHandle(label: string): HTMLElement {
  const row = screen.getByText(label).closest("li");
  if (!row) throw new Error(`expected a row for "${label}"`);
  const handle = row.querySelector<HTMLElement>('[data-testid="task-drag-handle"]');
  if (!handle) throw new Error(`expected a drag handle on "${label}"'s row`);
  return handle;
}

/**
 * The `[data-task-row-box]` `<div>` inside the row that renders `label` —
 * task-row.tsx's own header comment on why that `<div>`, not the `<li>`
 * around it, is "the row" for every visual/geometric purpose since issue
 * #192 nested a row's own sub-tasks inside its own `<li>`.
 */
function rowBox(label: string): HTMLElement {
  const row = screen.getByText(label).closest("li");
  if (!row) throw new Error(`expected a row for "${label}"`);
  const box = row.querySelector<HTMLElement>(":scope > [data-task-row-box]");
  if (!box) throw new Error(`expected a row box on "${label}"'s row`);
  return box;
}

describe("TaskTree", () => {
  // Pointer-drag tests below need real-looking row geometry and pointer
  // capture, neither of which jsdom implements — todo-page.test.tsx's own
  // `beforeEach` carries the identical stub and the identical reasoning.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      // Issue #192 nested a row's own sub-task `<ul>` *inside* that row's
      // own `<li>`, and `measureRows` (task-tree.tsx) now reads each
      // row's own `[data-task-row-box]` rather than the `<li>` itself
      // (that file's own header comment explains why: the `<li>` now
      // encloses any already-rendered subtree too). This stub still has
      // to key its stacked, `ROW_HEIGHT`-tall positions off the *row*
      // regardless of which of the two elements actually asked —
      // `closest("li")` finds the same `<li>` whether `this` is the
      // `<li>` itself or the row box inside it, and that `<li>`'s own
      // position among its own siblings in the owning `<ul>` is what
      // "stacked with no gaps" has always meant here.
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
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Sub-tasks keep their own order regardless of any sorting or grouping
  // applied to the list above them (issue #171's own acceptance
  // criterion) — this only checks the *rendering* half of that: a child
  // shows up nested under its own parent, indented one level deeper.
  it("renders a Task's own sub-tasks nested underneath it, one level deeper", async () => {
    const parent = task({ id: "parent", content: "plan trip" });
    const child = task({ id: "child", content: "book flights", parentId: "parent" });
    renderTree({
      tasks: [parent],
      listTaskChildren: vi.fn(async (parentId: string) => (parentId === "parent" ? [child] : [])),
    });

    await waitFor(() => expect(screen.getByText("book flights")).toBeInTheDocument());

    // depth 1 → 12px, depth 2 → 32px (12 + 1*20) — task-row.tsx's own
    // `paddingLeft` formula, read off each row's own `[data-task-row-box]`
    // (`rowBox`, this file's own helper) rather than the `<li>` around it
    // — issue #192 moved the padding there so a nested sub-task `<ul>`
    // isn't indented a second time on top of it.
    expect(rowBox("plan trip")).toHaveStyle({ paddingLeft: "12px" });
    expect(rowBox("book flights")).toHaveStyle({ paddingLeft: "32px" });
  });

  // Issue #192's own acceptance criterion, pinned structurally so it can't
  // silently regress back to the pre-#192 shape: a `<ul>` may hold only
  // `<li>` (plus `script`/`template`), and before this ticket a Task's own
  // sub-task list rendered as a *sibling* of that Task's own `<li>`,
  // both direct children of the level above — tolerated by browsers, but
  // invalid HTML that handed assistive technology no relationship between
  // a Task and its sub-tasks at all (task-tree.tsx's own header comment
  // carries the fuller account). This asserts the actual DOM shape, not
  // just that the padding looks right on screen.
  it("nests a sub-task's own <ul> inside its parent row's own <li>, not beside it", async () => {
    const parent = task({ id: "parent", content: "plan trip" });
    const child = task({ id: "child", content: "book flights", parentId: "parent" });
    renderTree({
      tasks: [parent],
      listTaskChildren: vi.fn(async (parentId: string) => (parentId === "parent" ? [child] : [])),
    });

    await waitFor(() => expect(screen.getByText("book flights")).toBeInTheDocument());

    const parentLi = screen.getByText("plan trip").closest("li");
    const childLi = screen.getByText("book flights").closest("li");
    expect(parentLi).not.toBeNull();
    expect(childLi).not.toBeNull();
    if (!parentLi || !childLi) throw new Error("expected both rows' own <li>");

    // The child's own <ul> — its own immediate list ancestor — has to be
    // the parent's own <li>, not the outer <ul> two levels up.
    const childList = childLi.closest("ul");
    expect(childList).not.toBeNull();
    expect(childList?.parentElement).toBe(parentLi);

    // The inverse claim, read directly off the parent's own <li>: every
    // one of its direct children is either the row's own box or another
    // `<ul>` — never a bare `<li>`, which is what a `ul > ul` sibling
    // shape (the pre-#192 bug) would have put there instead.
    const directChildren = Array.from(parentLi.children);
    expect(directChildren.length).toBeGreaterThan(0);
    for (const el of directChildren) {
      expect(["DIV", "UL"]).toContain(el.tagName);
    }
    expect(directChildren.some((el) => el.tagName === "UL")).toBe(true);
  });

  it("nests three levels deep, each one indent further than its own parent", async () => {
    const grandparent = task({ id: "gp", content: "level one" });
    const parent = task({ id: "p", content: "level two", parentId: "gp" });
    const child = task({ id: "c", content: "level three", parentId: "p" });
    renderTree({
      tasks: [grandparent],
      listTaskChildren: vi.fn(async (parentId: string) => {
        if (parentId === "gp") return [parent];
        if (parentId === "p") return [child];
        return [];
      }),
    });

    await waitFor(() => expect(screen.getByText("level three")).toBeInTheDocument());

    expect(rowBox("level one")).toHaveStyle({ paddingLeft: "12px" });
    expect(rowBox("level two")).toHaveStyle({ paddingLeft: "32px" });
    expect(rowBox("level three")).toHaveStyle({ paddingLeft: "52px" });
  });

  // Indenting the first Task in a sibling group has no preceding sibling
  // to nest under — a silent no-op, mirroring onMoveUp's own boundary
  // behaviour (task-row.test.tsx).
  it("indenting the first sibling in a group is a no-op", async () => {
    const setTaskParent = vi.fn(async () => {});
    const a = task({ id: "a", content: "only one so far" });
    renderTree({ tasks: [a], setTaskParent });

    await waitFor(() => expect(screen.getByText("only one so far")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByTestId("task-drag-handle"), { key: "ArrowRight", altKey: true });

    expect(setTaskParent).not.toHaveBeenCalled();
  });

  // Outdenting a top-level Task (no `parentTask` — this group has no
  // level above it) has nowhere to go — a silent no-op, the identical
  // "not every gesture always does something" contract.
  it("outdenting an already top-level Task is a no-op", async () => {
    const setTaskParent = vi.fn(async () => {});
    const a = task({ id: "a", content: "top level" });
    // `parentTask` intentionally omitted — this is the top-level group.
    renderTree({ tasks: [a], setTaskParent });

    await waitFor(() => expect(screen.getByText("top level")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByTestId("task-drag-handle"), { key: "ArrowLeft", altKey: true });

    expect(setTaskParent).not.toHaveBeenCalled();
  });

  // Indenting reparents under the preceding sibling, then appends the
  // moved Task after whatever that sibling's own children already were —
  // task-tree.tsx's own `handleIndent` doc comment.
  it("indenting the second sibling reparents it under the first, appended after its existing children", async () => {
    const setTaskParent = vi.fn(async () => {});
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "first", orderKey: "A" });
    const b = task({ id: "b", content: "second", orderKey: "B" });
    const existingChild = task({ id: "existing", content: "already a child", orderKey: "M" });
    const listTaskChildren = vi.fn(async (parentId: string) =>
      parentId === "a" ? [existingChild] : [],
    );
    renderTree({ tasks: [a, b], setTaskParent, reorderTask, listTaskChildren });

    await waitFor(() => expect(screen.getByText("second")).toBeInTheDocument());
    fireEvent.keyDown(screen.getAllByTestId("task-drag-handle")[1] as HTMLElement, {
      key: "ArrowRight",
      altKey: true,
    });

    await waitFor(() => expect(setTaskParent).toHaveBeenCalledWith("b", "a"));
    // listTaskChildren("a") is called again after the move (fresh, not
    // cached) to compute where "b" lands among "a"'s own children — this
    // fake still only returns `existingChild` (this fake store doesn't
    // simulate the write), so "b" is appended after it.
    await waitFor(() => expect(reorderTask).toHaveBeenCalledWith("b", expect.any(String)));
    const [, newKey] = reorderTask.mock.calls[0] as [string, string];
    expect(newKey > "M").toBe(true);
  });

  // Issue #171's drag-to-reparent — the pointer equivalent of the keyboard
  // test immediately above, reaching the identical `setTaskParent` call
  // through a release in a row's own *middle* band instead of Alt+ArrowRight
  // (this file's own header comment: "Drag must behave identically, not
  // invent a second story"). "a", "b" and "c" sit at DOM indices 0, 1 and 2
  // (rects 0-40, 40-80, 80-120, this file's own `ROW_HEIGHT` stub); dragging
  // "a" and releasing at y=100 lands in "c"'s own middle band ([90, 110),
  // `task-drag-recognizer.ts`'s own `REORDER_EDGE_FRACTION`) rather than
  // either of its edge bands.
  it("dropping in a row's own middle band reparents the dragged Task under it", async () => {
    const setTaskParent = vi.fn(async () => {});
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    const c = task({ id: "c", content: "c", orderKey: "C" });
    renderTree({ tasks: [a, b, c], setTaskParent, reorderTask });

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    const handle = dragHandle("a");
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 });

    await waitFor(() => expect(setTaskParent).toHaveBeenCalledWith("a", "c"));
    // Mirrors handleIndent's own "append as the target's own last child"
    // placement — this fake `listTaskChildren` returns `[]` for every
    // parent, so "a" lands alone among "c"'s children and reorderTask is
    // still called exactly once, per ADR 0050's "one drop still writes one
    // row" claim for the order half of a reparenting drop (this file's own
    // header comment on what a reparenting drop writes in total: one row
    // for `parentId`, one for `orderKey` — never a third row rewritten to
    // make room, which is the multi-row write ADR 0050 exists to avoid).
    await waitFor(() => expect(reorderTask).toHaveBeenCalledWith("a", expect.any(String)));
    expect(reorderTask).toHaveBeenCalledTimes(1);
  });

  // The store throws on the four-level cap or a cycle (TaskStore.setParent's
  // own doc comment) — reached identically from a drag as from the keyboard
  // path (`describeReparentError`, this file's header comment), not a
  // swallowed rejection.
  it("shows a toast, not a swallowed rejection, when a drag-reparent is refused", async () => {
    const setTaskParent = vi.fn(async () => {
      throw new Error("sub-tasks may nest at most 4 levels deep (parent is already at depth 4)");
    });
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    const c = task({ id: "c", content: "c", orderKey: "C" });
    renderTree({ tasks: [a, b, c], setTaskParent, reorderTask });

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    const handle = dragHandle("a");
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Sub-tasks only nest four levels deep"),
      ),
    );
    // The refused reparent must not also write an orderKey among children
    // it was never actually filed under.
    expect(reorderTask).not.toHaveBeenCalled();
  });

  // "The affordance stays absent, not inert" (this ticket's own brief),
  // extended from keyboard to drag: a sibling group already at
  // `MAX_TASK_NESTING_DEPTH` (4) offers no nest band at all — the same
  // pointer release that reparents at a shallower depth (the test above,
  // identical rows and identical y=100) resolves to an ordinary reorder
  // here instead, never to a `setTaskParent` call the store would only
  // refuse.
  it("offers no nest band at the nesting cap — the same drop reorders instead", async () => {
    const setTaskParent = vi.fn(async () => {});
    const reorderTask = vi.fn();
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    const c = task({ id: "c", content: "c", orderKey: "C" });
    renderTree({ tasks: [a, b, c], depth: 4, setTaskParent, reorderTask });

    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    const handle = dragHandle("a");
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 });

    await waitFor(() => expect(reorderTask).toHaveBeenCalledTimes(1));
    expect(setTaskParent).not.toHaveBeenCalled();
  });
});
