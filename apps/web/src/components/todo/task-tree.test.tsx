import type { Task } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import { LONG_PRESS_MS } from "@/lib/swipe-recognizer";
import { OPEN_SCHEDULE_EVENT } from "@/lib/todo-keymap";
import { mouseDragLeft, swipeDown, swipeLeft } from "@/test/swipe";
import { TaskTree } from "./task-tree";

vi.mock("@/components/ui/toast", () => {
  const toast = vi.fn() as unknown as typeof import("@/components/ui/toast").toast;
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
      onSetDate: vi.fn(),
      onSetDateString: vi.fn(),
      datesWithTasks: new Map(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      onRename: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    },
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    reorderTask: vi.fn(),
    setTaskParent: vi.fn(async () => {}),
    listTaskChildren: vi.fn(async () => []),
    countTaskChildren: vi.fn(async () => ({ done: 0, total: 0 })),
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

describe("the sub-task progress badge (issue #298)", () => {
  function parentWithChildren(done: number, total: number) {
    const parent = task({ id: "parent", content: "Parent" });
    const child = task({ id: "child", content: "Child", parentId: "parent" });
    return {
      tasks: [parent],
      // `listTaskChildren` is the ACTIVE children — what gets rendered. The
      // badge must not be read off it: that is the bug this covers.
      listTaskChildren: vi.fn(async (parentId: string) =>
        parentId === "parent" && done < total ? [child] : [],
      ),
      countTaskChildren: vi.fn(async (parentId: string) =>
        parentId === "parent" ? { done, total } : { done: 0, total: 0 },
      ),
    };
  }

  it("reads done/total, not the number of active children", async () => {
    renderTree(parentWithChildren(1, 2));

    expect(await screen.findByText("1/2")).toBeInTheDocument();
  });

  it("still shows the badge when every sub-task is done", async () => {
    // The defect this fixes: `listChildren` excludes completed rows, so a
    // parent with 2 of 2 finished had zero active children and the badge
    // vanished — counting down to nothing as work got done.
    renderTree(parentWithChildren(2, 2));

    expect(await screen.findByText("2/2")).toBeInTheDocument();
  });

  it("names the count for a screen reader, since 2/2 alone is ambiguous", async () => {
    renderTree(parentWithChildren(2, 2));

    expect(await screen.findByText("2 of 2 sub-tasks done")).toBeInTheDocument();
  });
});

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
    // Unconditional, not paired one-for-one with the two long-press tests'
    // own `vi.useFakeTimers()` calls: if either throws before reaching its
    // own `vi.useRealTimers()`, fake time would otherwise leak into every
    // test that runs after it in this file — `waitFor`'s own internal
    // polling (and, worse, React's scheduler) never resolves under fake
    // timers nobody is advancing, which reads as an unrelated cascade of
    // timeouts far from the actual failure. A no-op when timers are
    // already real, so this costs every other test in the file nothing.
    vi.useRealTimers();
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

  // Issue #308: a long-press on the row's own body — not the grip — has
  // to drive the SAME `reorderTask` call a grip-drag already does, end to
  // end, since #168's whole premise (this file's own header comment) is
  // that there is no second drag-execution path to build. Fake timers
  // stand in for the real hold; `clientY` travel afterwards is identical
  // to the grip-drag tests above, just started a different way.
  it("a touch long-press on the row's own body arms the identical reorder drag a grip-drag already does", async () => {
    const reorderTask = vi.fn();
    const setTaskParent = vi.fn(async () => {});
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    const c = task({ id: "c", content: "c", orderKey: "C" });
    // `depth: 4` — the nesting cap, mirroring the "offers no nest band at
    // the nesting cap" test just above — is what makes y=100 an ordinary
    // reorder rather than landing in a row's own nest band; this test's
    // own point is the ARMING path, not `dropIndexForPointer`'s own
    // nest/reorder split, which the tests around `dragHandle` above
    // already cover from the grip.
    renderTree({ tasks: [a, b, c], depth: 4, reorderTask, setTaskParent });

    // Waited for with REAL timers, before any fake ones go on below: this
    // tree's own top-level rows come straight from the `tasks` prop, no
    // query in the way, so this only ever needs the first render to
    // settle — but `waitFor`'s own internal polling (and React's own
    // scheduler) needs a real `setInterval`/`setTimeout` to do that at
    // all, which fake timers this test installs for its OWN
    // `LONG_PRESS_MS` would otherwise starve, hanging every test in this
    // file's own queue behind it once one did (this file's own `afterEach`
    // comment carries the fuller account of that failure mode).
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    const row = screen.getByText("a");

    vi.useFakeTimers();
    fireEvent.pointerDown(row, { pointerId: 9, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    // Armed now — a plain `<li>`, not the grip, is what carries the
    // pointer capture and the move/up handlers from here on (this file's
    // own `armLiftFromLongPress` doc comment, task-tree.tsx).
    const li = row.closest("li");
    if (!li) throw new Error("expected a row for 'a'");
    fireEvent.pointerMove(li, { pointerId: 9, clientY: 100 });
    fireEvent.pointerUp(li, { pointerId: 9, clientY: 100 });

    expect(reorderTask).toHaveBeenCalledTimes(1);
    expect(setTaskParent).not.toHaveBeenCalled();
  });

  // "Releasing without moving leaves the order unchanged and opens
  // nothing" (this ticket's own acceptance criterion) — armed, then
  // released with no travel at all.
  it("releasing a long-press lift without moving writes nothing", async () => {
    const reorderTask = vi.fn();
    const setTaskParent = vi.fn(async () => {});
    const a = task({ id: "a", content: "a", orderKey: "A" });
    const b = task({ id: "b", content: "b", orderKey: "B" });
    renderTree({ tasks: [a, b], reorderTask, setTaskParent });

    // See the previous test's own comment on why this waits with real
    // timers, before switching to fake ones below.
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    const row = screen.getByText("a");

    vi.useFakeTimers();
    fireEvent.pointerDown(row, { pointerId: 9, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    const li = row.closest("li");
    if (!li) throw new Error("expected a row for 'a'");
    fireEvent.pointerUp(li, { pointerId: 9, clientY: 10 });

    expect(reorderTask).not.toHaveBeenCalled();
    expect(setTaskParent).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Issue #308, on-device diagnosis: the row's own box still carries
  // `touch-pan-y` (issue #303, for swipe-to-schedule) once armed, so the
  // compositor claims the vertical axis and cancels the pointer stream
  // after the first real move — traced as `pointerdown` → `contextmenu`
  // → one `pointermove` → `pointercancel` → `lostpointercapture`, and
  // confirmed fixed on-device with a non-passive `touchmove` listener.
  // jsdom has no compositor and cannot reproduce that cancellation at all
  // (this file's own header comment on `getBoundingClientRect`/pointer
  // capture already leans on the identical limitation) — what follows is
  // NOT a claim that the gesture works, only that arming/disarming a
  // drag registers and unregisters the fix's own listener the way it has
  // to for the fix to have any chance of doing so on a real device.
  describe("the touchmove blocker that keeps a scroll from cancelling an armed drag (issue #308)", () => {
    function armViaGrip(label: string) {
      const handle = dragHandle(label);
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 10 });
      return handle;
    }

    /** The one `("touchmove", fn, { passive: false })` call `addEventListener` sees, or `undefined` if none was made. */
    function touchMoveBlockerCall(addSpy: ReturnType<typeof vi.spyOn>) {
      return addSpy.mock.calls.find((call: unknown[]) => call[0] === "touchmove");
    }

    it("registers a touchmove listener with passive: false the moment a drag arms, natively — not through React's own (passive) onTouchMove", async () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const a = task({ id: "a", content: "a", orderKey: "A" });
      renderTree({ tasks: [a] });

      await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
      expect(touchMoveBlockerCall(addSpy)).toBeUndefined();

      armViaGrip("a");

      const call = touchMoveBlockerCall(addSpy);
      expect(call).toBeDefined();
      expect(call?.[1]).toBeInstanceOf(Function);
      // The load-bearing option, per the on-device finding: React's own
      // root touch listeners are passive, and `preventDefault()` from a
      // passive listener is a silent no-op — this has to be the one
      // exception.
      expect(call?.[2]).toEqual({ passive: false });
    });

    it("removes the identical listener again on a normal release", async () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const removeSpy = vi.spyOn(document, "removeEventListener");
      const a = task({ id: "a", content: "a", orderKey: "A" });
      renderTree({ tasks: [a] });

      await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
      const handle = armViaGrip("a");
      const blocker = touchMoveBlockerCall(addSpy)?.[1];
      expect(blocker).toBeDefined();

      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 10 });

      expect(removeSpy).toHaveBeenCalledWith("touchmove", blocker);
    });

    it("removes the identical listener on a cancel too, not only on a clean release", async () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const removeSpy = vi.spyOn(document, "removeEventListener");
      const a = task({ id: "a", content: "a", orderKey: "A" });
      renderTree({ tasks: [a] });

      await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
      const handle = armViaGrip("a");
      const blocker = touchMoveBlockerCall(addSpy)?.[1];

      fireEvent.pointerCancel(handle, { pointerId: 1 });

      expect(removeSpy).toHaveBeenCalledWith("touchmove", blocker);
    });

    it("never registers a second listener for a drag that is already armed", async () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const a = task({ id: "a", content: "a", orderKey: "A" });
      renderTree({ tasks: [a] });

      await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
      const handle = armViaGrip("a");
      // A second, redundant pointerdown on the SAME already-armed drag —
      // `handlePointerDown`'s own `if (drag !== null) return` guard
      // (task-tree.tsx, pre-#308) is what this is actually pinning for
      // THIS entry point; without it, a reader whose finger jitters
      // mid-hold could leak one listener per jitter. `armDrag`'s own
      // identical guard is the one load-bearing for the long-press entry
      // point instead (`armLiftFromLongPress` has no guard of its own),
      // which this grip-only test does not exercise.
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 20 });

      const touchMoveCalls = addSpy.mock.calls.filter((call: unknown[]) => call[0] === "touchmove");
      expect(touchMoveCalls).toHaveLength(1);
    });

    // The registered function's own body, not just its existence — pins
    // what actually makes it the fix rather than an inert no-op.
    it("the registered listener actually calls preventDefault on the event it receives", async () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const a = task({ id: "a", content: "a", orderKey: "A" });
      renderTree({ tasks: [a] });

      await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
      armViaGrip("a");

      const blocker = touchMoveBlockerCall(addSpy)?.[1] as
        | ((event: TouchEvent) => void)
        | undefined;
      expect(blocker).toBeDefined();
      const fakeEvent = { preventDefault: vi.fn() } as unknown as TouchEvent;
      blocker?.(fakeEvent);

      expect(fakeEvent.preventDefault).toHaveBeenCalledTimes(1);
    });
  });

  describe("completed Tasks render in a trailing block below the active list (issue #358)", () => {
    it("renders after every active row, in a block of its own, with aria-checked", async () => {
      const a = task({ id: "a", content: "first", orderKey: "A" });
      const done = task({
        id: "mid",
        content: "middle, done",
        orderKey: "B",
        completedAt: "2026-01-01T00:00:00.000Z",
      });
      const c = task({ id: "c", content: "last", orderKey: "C" });
      renderTree({ tasks: [a, c], completedTasks: [done] });

      await waitFor(() => expect(screen.getByText("last")).toBeInTheDocument());
      const rows = screen.getAllByRole("listitem");
      // The trailing drop zone (an `aria-hidden` `<li>`) carries no
      // `listitem` role, so this reads as exactly the three real rows —
      // both active rows in `tasks`' own order, THEN the completed row,
      // not interleaved among them by `orderKey` the way a pre-#358 build
      // would have (`orderKey` "B" would have sorted it between "A" and
      // "C").
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("first"),
        expect.stringContaining("last"),
        expect.stringContaining("middle, done"),
      ]);
      const checkbox = screen.getByRole("checkbox", { name: "Mark task as incomplete" });
      expect(checkbox).toHaveAttribute("aria-checked", "true");
    });

    it("renders in a separate <ul> from the active list, entirely outside measureRows' own container", async () => {
      const a = task({ id: "a", content: "a", orderKey: "A" });
      const done = task({
        id: "mid",
        content: "done",
        orderKey: "B",
        completedAt: "2026-01-01T00:00:00.000Z",
      });
      renderTree({ tasks: [a], completedTasks: [done] });

      await waitFor(() => expect(screen.getByText("done")).toBeInTheDocument());
      const activeRow = screen.getByText("a").closest("li");
      const completedRow = screen.getByText("done").closest("li");
      expect(completedRow?.parentElement).not.toBe(activeRow?.parentElement);

      // The identical selector `measureRows` itself runs, scoped to the
      // active list's own container — it can never find the completed row
      // at all now, because that row isn't a child of this `<ul>` to begin
      // with (task-tree.tsx's own `measureRows` doc comment).
      const activeList = activeRow?.parentElement;
      const measured = activeList
        ? Array.from(activeList.querySelectorAll(":scope > li[data-task-id]"))
        : [];
      expect(measured.map((el) => el.getAttribute("data-task-id"))).toEqual(["a"]);
    });

    it("shows a Load-more control only once completed Tasks exceed one page, and loading more reveals the rest", async () => {
      const completed = Array.from({ length: 11 }, (_, index) =>
        task({
          id: `done-${index}`,
          content: `done ${index}`,
          completedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      renderTree({ tasks: [], completedTasks: completed });

      // 10 of 11 on screen (COMPLETED_TASKS_PAGE_SIZE), one remaining.
      await waitFor(() => expect(screen.getByText("done 0")).toBeInTheDocument());
      expect(screen.queryAllByText(/^done \d+$/)).toHaveLength(10);
      const loadMore = screen.getByRole("button", { name: "+1 completed task" });

      fireEvent.click(loadMore);

      expect(await screen.findByText("done 10")).toBeInTheDocument();
      expect(screen.queryAllByText(/^done \d+$/)).toHaveLength(11);
      expect(screen.queryByRole("button", { name: /completed task/ })).toBeNull();
    });

    it("shows no Load-more control at all when every completed Task already fits on one page", async () => {
      const done = task({ id: "a", content: "done", completedAt: "2026-01-01T00:00:00.000Z" });
      renderTree({ tasks: [], completedTasks: [done] });

      await waitFor(() => expect(screen.getByText("done")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: /completed task/ })).toBeNull();
    });

    it("renders even when every active Task is gone — a merely-completed list is not empty", async () => {
      const done = task({
        id: "a",
        content: "only completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      });
      renderTree({ tasks: [], completedTasks: [done] });

      expect(await screen.findByText("only completed")).toBeInTheDocument();
    });

    it("clicking a completed row's checkbox calls onUncomplete with the Task, not onComplete", async () => {
      const onUncomplete = vi.fn();
      const onComplete = vi.fn();
      const done = task({ id: "a", content: "done", completedAt: "2026-01-01T00:00:00.000Z" });
      renderTree({ tasks: [], completedTasks: [done], onUncomplete, onComplete });

      fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as incomplete" }));

      expect(onUncomplete).toHaveBeenCalledWith(done);
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("clicking a completed row's own title opens its detail view", async () => {
      const onOpenDetail = vi.fn();
      const done = task({ id: "a", content: "done", completedAt: "2026-01-01T00:00:00.000Z" });
      renderTree({
        tasks: [],
        completedTasks: [done],
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail,
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "done" }));

      expect(onOpenDetail).toHaveBeenCalledWith(done);
    });

    it("gives a completed row's own title the shared completed-style class", () => {
      const done = task({ id: "a", content: "done", completedAt: "2026-01-01T00:00:00.000Z" });
      renderTree({ tasks: [], completedTasks: [done] });

      expect(screen.getByRole("button", { name: "done" })).toHaveClass("completed-task-text");
    });

    it("carries no drag handle", async () => {
      // A completed row is not draggable at all (this file's own header
      // comment on `TaskTreeProps.completedTasks`) — asserted directly
      // against the markup rather than through a simulated drag, the same
      // "the attribute itself is what matters" reasoning the preceding
      // test uses for `measureRows`' own selector.
      const done = task({ id: "a", content: "done", completedAt: "2026-01-01T00:00:00.000Z" });
      renderTree({ tasks: [], completedTasks: [done] });

      await waitFor(() => expect(screen.getByText("done")).toBeInTheDocument());
      const completedRow = screen.getByText("done").closest("li");
      expect(completedRow).toHaveAttribute("data-completed-task", "true");
      expect(completedRow).toHaveAttribute("data-task-id", "a");
      expect(completedRow?.querySelector('[data-testid="task-drag-handle"]')).toBeNull();
    });
  });

  describe("Project badge — issue #310", () => {
    const errands = {
      id: "project-1",
      deviceId: "device-a",
      name: "Errands",
      colour: "#ff8d85",
      favourite: false,
      archived: false,
      parentId: null,
      description: null,
      orderKey: "V",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      seq: null,
      syncedAt: null,
      deletedAt: null,
    };
    const detailActionsWithErrands = {
      projects: [errands],
      labels: [],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetDate: vi.fn(),
      onSetDateString: vi.fn(),
      datesWithTasks: new Map(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
      onRename: vi.fn(),
      commentCountFor: vi.fn(() => 0),
    };

    it("hides an active row's Project badge when this tree's own projectId is set — a Project's own view", () => {
      renderTree({
        tasks: [task({ id: "a", content: "call mum", projectId: "project-1" })],
        projectId: "project-1",
        detailActions: detailActionsWithErrands,
      });

      expect(screen.queryByText("Errands")).not.toBeInTheDocument();
    });

    it("keeps an active row's Project badge when this tree's own projectId is null — Inbox", () => {
      renderTree({
        tasks: [task({ id: "a", content: "call mum", projectId: "project-1" })],
        projectId: null,
        detailActions: detailActionsWithErrands,
      });

      expect(screen.getByText("Errands")).toBeInTheDocument();
    });

    it("hides a completed row's Project badge too — the same non-null projectId, the tree's other TaskRow call site", async () => {
      const done = task({
        id: "a",
        content: "done",
        projectId: "project-1",
        completedAt: "2026-01-01T00:00:00.000Z",
      });
      renderTree({
        tasks: [],
        completedTasks: [done],
        projectId: "project-1",
        detailActions: detailActionsWithErrands,
      });

      await waitFor(() => expect(screen.getByText("done")).toBeInTheDocument());
      expect(screen.queryByText("Errands")).not.toBeInTheDocument();
    });
  });
});

describe("swipe-to-schedule (issue #303)", () => {
  // Reuses `use-swipe-actions.ts`'s shared recogniser — the identical one
  // History's own bubbles use (that hook's own header comment) — rather
  // than growing a second one for Tasks. This block is deliberately light:
  // the recogniser's own arithmetic (vertical-bail, flick/latch, edge
  // exclusion) is already mutation-tested in `swipe-recognizer.test.ts` and
  // `use-swipe-actions.test.tsx`; what's new *here* is only the wiring —
  // which row's own popover a swipe on THIS tree opens, and that a nested
  // sub-task's own swipe never also opens its parent's.

  it("opens the swiped row's own schedule popover, pre-filled with its date and offering to clear it", () => {
    renderTree({ tasks: [task({ id: "1", content: "buy milk", date: "2026-09-20" })] });
    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();

    swipeLeft(rowBox("buy milk"));

    expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
    // Pre-filled: "No Date" only ever renders once `dateDay !== null`
    // (task-schedule-popover.tsx's own `quickOptionDefs` filter) — this is
    // both proof the right Task's own date reached the popover and the
    // "way to clear it" the ticket's own acceptance criterion asks for.
    expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();
  });

  it("does not open anything for a vertical drag — the row scrolls instead", () => {
    // Mutation check: this is the test that must fail if
    // `use-swipe-actions.ts`'s reuse of the vertical-bail discrimination
    // were ever bypassed for Task rows specifically.
    renderTree({ tasks: [task({ content: "buy milk" })] });

    swipeDown(rowBox("buy milk"));

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
  });

  it("does nothing on a pointer device — the row's own hover actions serve there", () => {
    renderTree({ tasks: [task({ content: "buy milk" })] });

    mouseDragLeft(rowBox("buy milk"));

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
  });

  it("opens a swiped sub-task's own popover, not its parent's", async () => {
    // The recogniser is attached once, at this tree's own top level (depth
    // 1) — not once per nested TaskTree — so a nested sub-task's own
    // pointer events have to reach it by bubbling through the parent row's
    // `<li>` (issue #192 already nests a sub-task's own `<ul>` there).
    const parent = task({ id: "parent", content: "Parent", date: null });
    const child = task({ id: "child", content: "Child", parentId: "parent", date: "2026-09-20" });
    renderTree({
      tasks: [parent],
      listTaskChildren: vi.fn(async (parentId: string) => (parentId === "parent" ? [child] : [])),
    });
    await screen.findByText("Child");

    swipeLeft(rowBox("Child"));

    // Exactly one popover opened...
    expect(screen.getAllByTestId("scheduler-view")).toHaveLength(1);
    // ...and it's the Child's own: "No Date" only renders for a Task that
    // already has a date, which only Child does here.
    expect(screen.getByRole("button", { name: "No Date" })).toBeInTheDocument();
  });

  it("dispatches OPEN_SCHEDULE_EVENT exactly once for a nested sub-task's own swipe", async () => {
    // The test above can't tell "opened once" from "the identical open
    // fired twice" — both a correct single recogniser AND a second, wrongly
    // enabled one at the nested level resolve to the SAME `[data-swipe-
    // target]` element (the swipe hook walks up from the touched node, so
    // which container's own listener happened to run first makes no
    // difference to what it finds) and so produce the identical,
    // idempotent-looking open. Counting the underlying event is what
    // actually catches a second recogniser racing the first — this is the
    // test that fails if `enabled: depth === 1` above were widened to
    // `enabled: true` for every nested level too.
    const dispatchSpy = vi.spyOn(document, "dispatchEvent");
    const parent = task({ id: "parent", content: "Parent" });
    const child = task({ id: "child", content: "Child", parentId: "parent" });
    renderTree({
      tasks: [parent],
      listTaskChildren: vi.fn(async (parentId: string) => (parentId === "parent" ? [child] : [])),
    });
    await screen.findByText("Child");

    swipeLeft(rowBox("Child"));

    const scheduleDispatches = dispatchSpy.mock.calls.filter(
      ([event]) => event instanceof CustomEvent && event.type === OPEN_SCHEDULE_EVENT,
    );
    expect(scheduleDispatches).toHaveLength(1);
  });
});
