import type { Label, Project, Task } from "@meologue/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HORIZONTAL_THRESHOLD_PX, LONG_PRESS_MS, VERTICAL_BAIL_PX } from "@/lib/swipe-recognizer";
import { OPEN_COMMAND_MENU_EVENT, OPEN_SCHEDULE_EVENT } from "@/lib/todo-keymap";
import { TaskRow } from "./task-row";

/**
 * Stands in for the real `TaskTitleEditor` — `task-title-editor.tsx`'s own
 * header comment records why no test mounts that component directly: it
 * wraps a real ProseMirror `EditorView`, and jsdom "cannot usefully mount
 * [one], let alone type into it" (`composer.tsx`'s own identical finding
 * for the Composer). Mocking exactly this module, not `TaskRow` or
 * `TaskRowContent` themselves, is the same split `todo-sidebar.test.tsx`
 * and `chat-shell-layout.test.tsx` already use for `entry-store-layout.tsx`
 * (mocked there because it needs a real SqliteDriver) — everything this
 * suite actually wants to prove (double-click activates it, Enter commits
 * through `detailActions.onRename`, Escape cancels) lives in the wiring
 * around the editor, not inside the editor itself.
 */
function StubTaskTitleEditor({
  value,
  onCommit,
  onCancel,
  ariaLabel,
}: {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      aria-label={ariaLabel ?? "Task name"}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => onCommit(text)}
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

vi.mock("@/components/todo/task-title-editor", () => ({
  TaskTitleEditor: StubTaskTitleEditor,
}));

function label(overrides: Partial<Label> = {}): Label {
  return {
    id: "label-1",
    deviceId: "device-a",
    name: "urgent",
    colour: "#ff8d85",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
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
    ...overrides,
  };
}

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
    // same default packages/core/src/test-support/task-fixture.ts uses,
    // so a test that wants a scheduled Task says so explicitly via
    // `overrides` rather than this fixture guessing at one.
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

function renderRow(overrides: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const props = {
    task: task(),
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
    isDropTarget: false,
    onHandlePointerDown: vi.fn(),
    onHandlePointerMove: vi.fn(),
    onHandlePointerUp: vi.fn(),
    onHandlePointerCancel: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onIndent: vi.fn(),
    onOutdent: vi.fn(),
    ...overrides,
  };
  render(
    <ul>
      <TaskRow {...props} />
    </ul>,
    { wrapper: MemoryRouter },
  );
  return props;
}

/**
 * The `[data-task-row-box]` `<div>` inside the rendered row — issue #192
 * moved every visual class, the depth padding, and (since exactly one
 * `TaskRow` ever renders per `renderRow` call here) every one of those
 * onto this element rather than the `<li>` around it, so a test asserting
 * on any of them has to look here now — task-row.tsx's own header comment
 * carries the fuller reasoning for the split.
 */
function rowBox(): HTMLElement {
  const box = document.querySelector<HTMLElement>("[data-task-row-box]");
  if (!box) throw new Error("expected a row box");
  return box;
}

function ringSpan(): HTMLElement {
  const span = screen.getByRole("checkbox").querySelector<HTMLElement>("span");
  if (!span) throw new Error("expected the checkbox's own ring span");
  return span;
}

describe("TaskRow", () => {
  it("renders the Task's content, with the checkbox unticked", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.getByText("call mum")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Mark task as complete" })).not.toBeChecked();
  });

  it("renders markdown in the title as real formatting, not literal characters", () => {
    renderRow({ task: task({ content: "ZZ probe **bold** _em_ `code`" }) });

    // The title button's own accessible name is computed from its
    // rendered content, so a browser (and RTL) reads it as the plain
    // words — this also proves the button still opens the detail view
    // via `data-row-nav-target`, unaffected by the markup swap inside it.
    const titleButton = screen.getByRole("button", { name: "ZZ probe bold em code" });
    expect(titleButton).toHaveAttribute("data-row-nav-target");
    expect(titleButton.querySelector("strong")?.textContent).toBe("bold");
    expect(titleButton.querySelector("em")?.textContent).toBe("em");
    expect(titleButton.querySelector("code")?.textContent).toBe("code");
  });

  // Issue #398: a saved title's `[text](url)` renders as a live link, not
  // the raw bracket syntax — `task-title-text.test.tsx` covers the
  // renderer itself in isolation; this proves `TaskRowContent` actually
  // calls it for a real Task.
  it("renders a saved [text](url) title as a live link", () => {
    const onOpenDetail = vi.fn();
    renderRow({
      task: task({ content: "Read [my article](https://example.com/post)" }),
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

    const link = screen.getByRole("link", { name: "my article" });
    expect(link).toHaveAttribute("href", "https://example.com/post");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Still sits inside the row's own title button (not a query by
    // accessible NAME here — a browser's accname computation doesn't
    // preserve the space between a plain-text run and a following
    // element's own text the way `textContent` does, so "Read " + "my
    // article" collapses to "Readmy article" for that purpose even though
    // the rendered text, asserted below, has the space).
    const titleButton = link.closest("button");
    expect(titleButton).toHaveAttribute("data-row-nav-target");
    expect(titleButton).toHaveTextContent("Read my article");

    fireEvent.click(link);
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("keeps aria-labels as the raw, unrendered title — aria-labels are unrecorded", () => {
    renderRow({ task: task({ content: "ZZ probe **bold** _em_ `code`" }) });

    expect(
      screen.getByRole("button", { name: 'Edit "ZZ probe **bold** _em_ `code`"' }),
    ).toBeInTheDocument();
  });

  it("ticking the checkbox calls onComplete", () => {
    const onComplete = vi.fn();
    renderRow({ onComplete });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("ticking a recurring Task's checkbox still calls onComplete, not onCompleteForever", () => {
    // A recurring Task's own checkbox is still an ordinary tap most of the
    // time — Shift+Click is the one exception (the next test) — advancing
    // to the next occurrence, not ending the series (TaskStore.
    // advanceRecurring's own doc comment, and todo-page.tsx's own
    // handleComplete, which is what actually decides between complete()
    // and advanceRecurring() based on `dateString`; this row only ever
    // decides between onComplete and onCompleteForever).
    const onComplete = vi.fn();
    const onCompleteForever = vi.fn();
    renderRow({ task: task({ dateString: "every month" }), onComplete, onCompleteForever });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCompleteForever).not.toHaveBeenCalled();
  });

  it("Shift+Click on a recurring Task's checkbox calls onCompleteForever, not onComplete", () => {
    // Todoist's own documented gesture for "Complete and archive recurring
    // task" — the end of the series, never "complete this occurrence"
    // (BRIEF.md's own "Domain decisions you must not re-derive").
    const onComplete = vi.fn();
    const onCompleteForever = vi.fn();
    renderRow({ task: task({ dateString: "every month" }), onComplete, onCompleteForever });

    fireEvent.click(screen.getByRole("checkbox"), { shiftKey: true });

    expect(onCompleteForever).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("Shift+Click on a non-recurring Task's checkbox is an ordinary complete", () => {
    // The modifier is meaningless without a series to end — ignored rather
    // than doing nothing, so an accidental Shift held down never silently
    // eats the tap.
    const onComplete = vi.fn();
    const onCompleteForever = vi.fn();
    renderRow({ task: task({ dateString: null }), onComplete, onCompleteForever });

    fireEvent.click(screen.getByRole("checkbox"), { shiftKey: true });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCompleteForever).not.toHaveBeenCalled();
  });

  it("shows a touch-reachable 'Complete and archive' button only for a recurring Task", () => {
    const onCompleteForever = vi.fn();
    renderRow({
      task: task({ content: "pay rent", dateString: "every month" }),
      onCompleteForever,
    });

    fireEvent.click(
      screen.getByRole("button", { name: 'Complete and archive recurring task "pay rent"' }),
    );

    expect(onCompleteForever).toHaveBeenCalledTimes(1);
  });

  it("renders no 'Complete and archive' button for a non-recurring Task", () => {
    renderRow({ task: task({ content: "pay rent", dateString: null }) });

    expect(screen.queryByRole("button", { name: /Complete and archive/ })).not.toBeInTheDocument();
  });

  describe("a completed Task renders through this same row", () => {
    it("carries aria-checked=true and 'Mark task as incomplete'", () => {
      renderRow({ task: task({ completedAt: "2026-01-01T00:00:00.000Z" }) });

      const checkbox = screen.getByRole("checkbox", { name: "Mark task as incomplete" });
      expect(checkbox).toHaveAttribute("aria-checked", "true");
    });

    it("clicking the checkbox calls onUncomplete, not onComplete", () => {
      const onComplete = vi.fn();
      const onUncomplete = vi.fn();
      renderRow({
        task: task({ completedAt: "2026-01-01T00:00:00.000Z" }),
        onComplete,
        onUncomplete,
      });

      fireEvent.click(screen.getByRole("checkbox", { name: "Mark task as incomplete" }));

      expect(onUncomplete).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("gives the title the shared completed-style class", () => {
      renderRow({ task: task({ content: "done", completedAt: "2026-01-01T00:00:00.000Z" }) });

      expect(screen.getByRole("button", { name: "done" })).toHaveClass("completed-task-text");
    });

    it("does not give an active Task's title the completed-style class", () => {
      renderRow({ task: task({ content: "not done", completedAt: null }) });

      expect(screen.getByRole("button", { name: "not done" })).not.toHaveClass(
        "completed-task-text",
      );
    });

    it("keeps its date badge, Labels, Project name and comment count — the same metadata line an active row shows", () => {
      renderRow({
        task: task({
          content: "done",
          completedAt: "2026-01-01T00:00:00.000Z",
          date: "2026-01-01",
          labelIds: ["label-1"],
          projectId: "project-1",
        }),
        commentCount: 2,
        detailActions: {
          projects: [project()],
          labels: [label()],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString: vi.fn(),
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 2),
        },
      });

      expect(screen.getByText("urgent")).toBeInTheDocument();
      expect(screen.getByText("Errands")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "2 comments" })).toBeInTheDocument();
      expect(rowBox().style.minHeight).toBe("59px");
      expect(ringSpan().querySelector("svg")).toBeInTheDocument();
    });

    it("hides the 'Complete and archive recurring task' button once the Task is completed", () => {
      renderRow({
        task: task({
          content: "pay rent",
          dateString: "every month",
          completedAt: "2026-01-01T00:00:00.000Z",
        }),
      });

      expect(
        screen.queryByRole("button", { name: /Complete and archive/ }),
      ).not.toBeInTheDocument();
    });

    it("carries data-completed-task, excluding it from drag/reorder geometry", () => {
      renderRow({ task: task({ completedAt: "2026-01-01T00:00:00.000Z" }) });

      expect(screen.getByRole("listitem")).toHaveAttribute("data-completed-task", "true");
    });

    it("keeps its hover controls (Edit, Date, Comment, More) working — neither artifact says otherwise", () => {
      renderRow({ task: task({ content: "done", completedAt: "2026-01-01T00:00:00.000Z" }) });

      expect(screen.getByRole("button", { name: 'Edit "done"' })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: 'Date "done"' })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: 'Comment on "done"' })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: 'More actions for "done"' })).toBeInTheDocument();
    });

    it("renders no drag handle when the caller omits the drag/reorder props (as task-tree.tsx does for a completed row)", () => {
      renderRow({
        task: task({ completedAt: "2026-01-01T00:00:00.000Z" }),
        onHandlePointerDown: undefined,
        onHandlePointerMove: undefined,
        onHandlePointerUp: undefined,
        onHandlePointerCancel: undefined,
        onMoveUp: undefined,
        onMoveDown: undefined,
        onIndent: undefined,
        onOutdent: undefined,
      });

      expect(screen.queryByTestId("task-drag-handle")).not.toBeInTheDocument();
    });
  });

  it.each([
    ["P1", 4],
    ["P2", 3],
    ["P3", 2],
  ])("thickens the checkbox ring to 2px at %s", (_uiLabel, storedPriority) => {
    renderRow({ task: task({ priority: storedPriority }) });

    expect(ringSpan().style.boxShadow).toContain("2px");
  });

  it("keeps the checkbox ring at 1px for P4 ('no priority'), the one default level", () => {
    renderRow({ task: task({ priority: 1 }) });

    expect(ringSpan().style.boxShadow).toContain("1px");
  });

  it("shows the recurrence exactly as typed, not a paraphrase", () => {
    renderRow({ task: task({ dateString: "every other monday" }) });

    expect(screen.getByText("every other monday")).toBeInTheDocument();
  });

  // Issue #178 moved Delete off the row's own hover actions entirely — it
  // lives behind the "More actions" (⋯) menu now, alongside the rest of
  // the full command set, per this ticket's own reference behaviour.
  it("Delete, in the More actions menu, calls onRequestDelete, not the store directly", () => {
    const onRequestDelete = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onRequestDelete });

    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));

    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  // Pointer Events, not native HTML5 drag-and-drop — issue #168's own
  // follow-up: Android WebView never synthesises `dragstart` from touch
  // input, so the drag has to work through the same mechanism on every
  // device rather than one that only a mouse can trigger.
  it("the grip handle forwards pointer events to the handlers it's given, and the row itself is not draggable", () => {
    const onHandlePointerDown = vi.fn();
    const onHandlePointerMove = vi.fn();
    const onHandlePointerUp = vi.fn();
    const onHandlePointerCancel = vi.fn();
    renderRow({
      onHandlePointerDown,
      onHandlePointerMove,
      onHandlePointerUp,
      onHandlePointerCancel,
    });

    const row = screen.getByRole("listitem");
    expect(row).not.toHaveAttribute("draggable");

    const handle = screen.getByTestId("task-drag-handle");
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(onHandlePointerDown).toHaveBeenCalledTimes(1);
    expect(onHandlePointerMove).toHaveBeenCalledTimes(1);
    expect(onHandlePointerUp).toHaveBeenCalledTimes(1);
    expect(onHandlePointerCancel).toHaveBeenCalledTimes(1);
  });

  // Issue #171's keyboard reorder — the handle is a real, focusable
  // `<button>` for exactly this reason (its own doc comment).
  it("ArrowUp/ArrowDown on the handle call onMoveUp/onMoveDown", () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    renderRow({ onMoveUp, onMoveDown });

    const handle = screen.getByTestId("task-drag-handle");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });

    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(onMoveDown).toHaveBeenCalledTimes(1);
  });

  // Issue #171's keyboard reparent — `Alt`+arrow, not a plain arrow (which
  // this file's own test above already claims for reorder) and not `Tab`
  // (onOutdent's own doc comment, TaskRowProps, on why).
  it("Alt+ArrowRight/Alt+ArrowLeft on the handle call onIndent/onOutdent", () => {
    const onIndent = vi.fn();
    const onOutdent = vi.fn();
    const onMoveUp = vi.fn();
    renderRow({ onIndent, onOutdent, onMoveUp });

    const handle = screen.getByTestId("task-drag-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", altKey: true });
    // A plain, unmodified ArrowRight/ArrowLeft is not reorder or reparent
    // — only ArrowUp/ArrowDown (unmodified) and Alt+ArrowRight/ArrowLeft
    // are ever recognised, so a stray ArrowLeft with no modifier must do
    // nothing at all.
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(onIndent).toHaveBeenCalledTimes(1);
    expect(onOutdent).toHaveBeenCalledTimes(1);
    expect(onMoveUp).not.toHaveBeenCalled();
  });

  // Issue #308 deliberately contradicts what this test used to assert
  // ("does not put pointer listeners on the row itself, only on the
  // handle") — the row's own body is now a long-press-to-lift candidate
  // too. A mouse is the one pointer type that still gets none of this: it
  // reaches reorder through the grip and the command menu through
  // right-click, exactly as before.
  it("a mouse pointerdown on the row body arms nothing — the grip and right-click still own that pointer", () => {
    vi.useFakeTimers();
    const onHandlePointerDown = vi.fn();
    const onLongPressArm = vi.fn();
    renderRow({ onHandlePointerDown, onLongPressArm });

    fireEvent.pointerDown(screen.getByText("buy milk"), { pointerId: 1, pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onHandlePointerDown).not.toHaveBeenCalled();
    expect(onLongPressArm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // The acceptance criterion this whole ticket turns on: "a test states
  // which breakpoint and pointer type it asserts." This one asserts
  // `pointerType: "touch"` on the event itself, never a screen-width
  // breakpoint — the same per-gesture, not per-device, distinction
  // `onPointerDown`'s own comment (task-row.tsx) draws for why this isn't
  // read off `lib/pointer.ts`'s media queries instead.
  it("holding the row body on a touch pointer arms the lift once LONG_PRESS_MS elapses with no disqualifying movement", () => {
    vi.useFakeTimers();
    const onLongPressArm = vi.fn();
    renderRow({ onLongPressArm });

    const row = screen.getByText("buy milk");
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 100 });

    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1));
    expect(onLongPressArm).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onLongPressArm).toHaveBeenCalledTimes(1);
    expect(onLongPressArm).toHaveBeenCalledWith(7, expect.anything());

    vi.useRealTimers();
  });

  // "A press that turns into a vertical drag scrolls the list instead of
  // lifting" (this ticket's own acceptance criterion) — the row's own
  // timer never gets to arm anything once a real scroll is already
  // underway.
  it("a vertical drag past the bail threshold before the timer fires cancels the lift, letting the row scroll instead", () => {
    vi.useFakeTimers();
    const onLongPressArm = vi.fn();
    renderRow({ onLongPressArm });

    const row = screen.getByText("buy milk");
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(row, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 100,
      clientY: 100 + VERTICAL_BAIL_PX + 1,
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPressArm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // The third leg of the same race: a horizontal excursion big enough to
  // read as swipe-to-schedule must not ALSO leave the lift armed once its
  // timer catches up — `lib/task-lift-recognizer.ts`'s own header comment
  // on why this reuses swipe-recognizer.ts's identical threshold rather
  // than a second, independently-tuned one.
  it("a horizontal drag past the swipe threshold before the timer fires also cancels the lift", () => {
    vi.useFakeTimers();
    const onLongPressArm = vi.fn();
    renderRow({ onLongPressArm });

    const row = screen.getByText("buy milk");
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(row, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 100 - (HORIZONTAL_THRESHOLD_PX + 1),
      clientY: 100,
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPressArm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Releasing before the timer ever fires — a plain tap — must not arm a
  // lift late, once the pointer is already gone.
  it("releasing before LONG_PRESS_MS elapses never arms the lift, even once that much time later passes", () => {
    vi.useFakeTimers();
    const onLongPressArm = vi.fn();
    renderRow({ onLongPressArm });

    const row = screen.getByText("buy milk");
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerUp(row, { pointerId: 7, pointerType: "touch", clientX: 100, clientY: 100 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPressArm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("draws the drop indicator only while it is the drop target", () => {
    renderRow({ isDropTarget: true });

    expect(rowBox()).toHaveClass("border-t-primary");
  });

  // Issue #171's drag-to-reparent: nesting draws a genuinely different
  // indicator from ordinary reordering, not the same top border reused —
  // a reader mid-drag has to be able to tell "lands between rows" from
  // "lands inside this row" without waiting to see what happens on
  // release (this ticket's own brief names conflating the two as a real
  // risk).
  it("draws a distinct row-highlight indicator, not the reorder line, while it is the nest target", () => {
    renderRow({ isNestTarget: true });

    const box = rowBox();
    expect(box).toHaveClass("ring-primary");
    expect(box).not.toHaveClass("border-t-primary");
  });

  it("draws neither indicator when the row is neither the reorder nor the nest target", () => {
    renderRow({ isDropTarget: false, isNestTarget: false });

    const box = rowBox();
    expect(box).not.toHaveClass("border-t-primary");
    expect(box).not.toHaveClass("ring-primary");
  });

  // Issue #308's own required acceptance criterion: "the row visibly lifts
  // while held." `-translate-y-1` is the specific class that draws it —
  // asserted as a whole token via `toHaveClass`, not a `className.includes`
  // check: `className.toContain` would still pass after renaming this
  // class to, say, `-translate-y-1x` (this repo's own recorded near-miss,
  // `touch-pan-y`/`touch-pan-yX`), since `toContain` on a string is a
  // substring test, not a token test.
  it("draws the lifted-card elevation only while it is the row being dragged", () => {
    renderRow({ isDragging: true });

    expect(rowBox()).toHaveClass("-translate-y-1");
    expect(rowBox()).toHaveClass("shadow-lg");
  });

  it("draws no elevation when the row is not being dragged", () => {
    renderRow({ isDragging: false });

    expect(rowBox()).not.toHaveClass("-translate-y-1");
    expect(rowBox()).not.toHaveClass("shadow-lg");
  });

  // Issue #253: the Date button now anchors its own `TaskSchedulePopover`
  // instance directly — it no longer opens the shared bottom sheet. That
  // sheet had no other door from this row at all once issue #376 removed
  // the More-actions "Deadline…" item that used to be the other one.
  // `scheduler-view` is the popover's own `data-testid`
  // (task-schedule-popover.tsx) — jsdom lays nothing out, so this proves
  // the popover opens, not that it anchors under the button; see this
  // ticket's own report for why anchoring itself needs a real browser.
  // "Schedule" was renamed "Date" (issue #178's own reference behaviour —
  // the row's four hover actions read Edit, Date, Comment, More).
  it("the Date button opens this row's own anchored scheduler popover, not the shared sheet", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));

    expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
  });

  // Issue #253: the More-actions "Date…" item is a second entry point onto
  // the identical per-row popover instance the hover button above opens —
  // both flip the same `scheduleOpen` flag `task-row.tsx` owns.
  //
  // Issue #255: opening the popover now waits for the More-actions menu's
  // own `onCloseAutoFocus` (fired once Radix's `Presence` actually finishes
  // closing the menu's Content) rather than happening synchronously inside
  // `onSelect` — see task-command-menu.tsx's own doc comment on the "Date…"
  // item for why. jsdom runs no real CSS animation, so this still resolves
  // quickly, but asynchronously — hence `waitFor` rather than an immediate
  // assertion.
  it("the More-actions 'Date…' item opens the identical scheduler popover", async () => {
    renderRow({ task: task({ content: "call mum" }) });

    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Date/ }));

    await waitFor(() => expect(screen.getByTestId("scheduler-view")).toBeInTheDocument());
  });

  // Issue #253: the `T` shortcut's own fan-in — `use-todo-keymap.ts`
  // dispatches `OPEN_SCHEDULE_EVENT` (todo-keymap.ts) rather than calling
  // this row directly, the identical document-level mechanism
  // `OPEN_COMMAND_MENU_EVENT` already uses for `.` below.
  it("opens the scheduler popover when todo-keymap.ts's own OPEN_SCHEDULE_EVENT names this Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId: "1" } }));
    });

    expect(screen.getByTestId("scheduler-view")).toBeInTheDocument();
  });

  it("ignores OPEN_SCHEDULE_EVENT when it names a different Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    act(() => {
      document.dispatchEvent(
        new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId: "other-task" } }),
      );
    });

    expect(screen.queryByTestId("scheduler-view")).not.toBeInTheDocument();
  });

  // Issue #296: this row's own `TaskSchedulePopover` wiring (the "No Date"
  // clear and the Repeat menu's "Every day" pick, both inside
  // `task-row-content.tsx`) used to thread `new Date().toISOString()`
  // through `onSetDateString`'s third argument — `TaskStore.setDateString`'s
  // own doc comment (packages/core) says that parameter (`today`) has
  // always meant a floating local calendar day, never an instant. Slicing
  // an instant's first ten characters names the UTC day, not the Device's
  // own, for a window each night as wide as the Device's own UTC offset —
  // the identical shape of bug issue #290 fixed for
  // `advanceRecurringTask`/`postponeTask` in use-tasks.ts, and
  // `task-detail-view.test.tsx`'s own identical suite covers the sibling
  // call site. These tests pin both directions the same way: a Device
  // east of UTC before its own midnight has reached UTC, and one west of
  // UTC after local time has already rolled into UTC's next day.
  describe("issue #296 — onSetDateString receives the local day, not UTC's", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    function renderRowWithOnSetDateString(
      taskOverrides: Partial<Task>,
      onSetDateString: (id: string, dateString: string | null, today: string) => void,
    ) {
      renderRow({
        task: task({ id: "1", content: "call mum", ...taskOverrides }),
        detailActions: {
          projects: [],
          labels: [],
          onOpenDetail: vi.fn(),
          onSetPriority: vi.fn(),
          onSetDate: vi.fn(),
          onSetDateString,
          datesWithTasks: new Map(),
          onSetProject: vi.fn(),
          onSetLabels: vi.fn(),
          onCopyLink: vi.fn(),
          onRename: vi.fn(),
          commentCountFor: vi.fn(() => 0),
        },
      });
    }

    it("clearing the date with No Date reports the local day for a Device east of UTC, before its own midnight has reached UTC", () => {
      vi.stubEnv("TZ", "Asia/Kolkata");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 15, 0, 16, 18));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString(
        { date: "2026-09-14", dateString: "every day" },
        onSetDateString,
      );

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", null, "2026-09-15");
    });

    it("clearing the date with No Date reports the local day for a Device west of UTC, once local time has already rolled into UTC's next day", () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 14, 23, 45, 0));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString(
        { date: "2026-09-13", dateString: "every day" },
        onSetDateString,
      );

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      fireEvent.click(screen.getByRole("button", { name: "No Date" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", null, "2026-09-14");
    });

    it("picking 'Every day' from the Repeat menu reports the local day for a Device east of UTC, before its own midnight has reached UTC", () => {
      vi.stubEnv("TZ", "Asia/Kolkata");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 15, 0, 16, 18));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString({ date: null, dateString: null }, onSetDateString);

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      // Radix's `DropdownMenu.Trigger` opens on `pointerdown`, not `click`
      // — task-schedule-popover.test.tsx's own `openRepeatMenu` helper
      // establishes this identically for the same "Repeat" button.
      fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
      const menu = screen.getByTestId("repeat-menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every day" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", "every day", "2026-09-15");
    });

    it("picking 'Every day' from the Repeat menu reports the local day for a Device west of UTC, once local time has already rolled into UTC's next day", () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 8, 14, 23, 45, 0));

      const onSetDateString = vi.fn();
      renderRowWithOnSetDateString({ date: null, dateString: null }, onSetDateString);

      fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Repeat" }));
      const menu = screen.getByTestId("repeat-menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Every day" }));

      expect(onSetDateString).toHaveBeenCalledWith("1", "every day", "2026-09-14");
    });
  });

  // Issue #376: the More-actions "Deadline…" item is gone — no surface
  // offers to set, edit, clear or display a deadline.
  it("the More-actions menu has no 'Deadline…' item", () => {
    renderRow({ task: task({ content: "call mum" }) });

    fireEvent.pointerDown(screen.getByRole("button", { name: 'More actions for "call mum"' }));

    expect(screen.queryByRole("menuitem", { name: /^Deadline/ })).not.toBeInTheDocument();
  });

  it("on a hover-capable pointer, a row's actions render in the fixed order Edit, Date, Comment, More", () => {
    renderRow({ task: task({ content: "call mum" }) });

    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);

    // Only the four hover actions, checked by their relative order — the
    // drag handle and the checkbox carry their own, differently-shaped
    // labels and aren't part of this claim.
    const hoverActionLabels = buttons.filter((label) =>
      /^(Edit|Date|Comment on|More actions for)/.test(label),
    );
    expect(hoverActionLabels).toEqual([
      'Edit "call mum"',
      'Date "call mum"',
      'Comment on "call mum"',
      'More actions for "call mum"',
    ]);
  });

  // A real device (1080x2400) found this the hard way: with all four
  // hover actions following the pre-existing `(hover: hover)` convention
  // — visible unless a hover-capable pointer says otherwise — a touch
  // reader with no hover at all got all four, permanently, on a 349px
  // row. Four 44px buttons plus the grip handle and checkbox left "call
  // the dentist" as little as 37px to render in, and it came out "call …".
  //
  // jsdom (this project's test environment, `vite.config.ts`'s own `test.
  // environment: "jsdom"`, with no `css: true`) never loads Tailwind's
  // actual generated stylesheet, so nothing here can assert real
  // `display`/visibility the way a browser would — `toBeVisible()` would
  // pass or fail independent of any class on the element. What's actually
  // load-bearing, and what this asserts instead, is the exact utility
  // classes Tailwind mechanically turns into that CSS: `hidden` (the base,
  // no-hover state) overridden only by a hover-capable media query.
  //
  // Issue #309: More used to be the one exception — it carried no `hidden`
  // at all, because it was the only door onto the full command set (Edit,
  // Date, Priority, Deadline, Labels, Move to…, Copy link, Delete) on a
  // touch-only device. #302's detail sheet (inline Date/Priority/Labels/
  // Project fields — Deadline too, until issue #376 removed its own field
  // — plus its own `⋮` overflow for Copy link/Complete forever/Delete)
  // and #308's long-press lift (reordering) between them
  // give a touch reader a door onto every one of those actions without
  // this menu, so More now rides the identical `hidden pointer-fine:flex`
  // gate as the other three — this asserts it does, on a device that
  // reports coarse-and-hoverless (a genuine touchscreen, not a Tauri
  // misreport), the exact device this file's own `pointer-fine` doc
  // comment names.
  //
  // Issue #224 widened that media query from plain `(hover: hover)` to
  // `(hover: hover),(pointer: fine)` — `task-row-content.tsx`'s own comment
  // explains why: a Tauri desktop window can misreport `(hover: none)` for
  // a real mouse, and OR-ing in `(pointer: fine)` is what stops that
  // misreport from also taking these four buttons away on a build the real
  // device fix above was never about. It now rides the `pointer-fine`
  // variant declared in index.css rather than an inline arbitrary one.
  //
  // **Read the limit of this assertion honestly.** `toHaveClass` proves a
  // string is on the element and nothing more — it cannot see whether any
  // CSS was ever generated for that name. This very test passed while the
  // classes were assembled by template interpolation, which Tailwind's
  // text scanner never sees, so no rule existed and every one of these
  // buttons was fully visible on every row. The class name and the applied
  // style are two different claims; only rendering the real stylesheet
  // settles the second, which is what the side-by-side rig is for.
  it("Edit, Date, Comment, More and the drag handle are all hidden outside a hover-or-fine-pointer device — asserts the `pointer-fine` gate `(hover: hover) OR (pointer: fine)`, none render on a coarse-and-hoverless touchscreen", () => {
    renderRow({ task: task({ content: "call mum" }) });

    for (const label of [
      'Edit "call mum"',
      'Date "call mum"',
      'Comment on "call mum"',
      'More actions for "call mum"',
    ]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toHaveClass("hidden");
      expect(button).toHaveClass("pointer-fine:flex");
    }

    const handle = screen.getByTestId("task-drag-handle");
    expect(handle).toHaveClass("hidden");
    expect(handle).toHaveClass("pointer-fine:flex");
  });

  // Issue #309's own "inset reclaimed" acceptance criterion, spelled out
  // separately from the test above even though it reads the identical two
  // classes off the identical element: this is the ONE assertion in this
  // file that the checkbox's own 12px inset actually depends on. `hidden`
  // (not `opacity-0`) is what removes the handle from this row's flex
  // layout on a coarse-and-hoverless device rather than merely fading it in
  // place, still reserving the 32px (24px handle + this row's own `gap-2`)
  // it used to. jsdom lays out no real flexbox (no `css: true`, per the
  // test above's own doc comment), so nothing here can observe the
  // checkbox's rendered x-position the way the device measurement that
  // drove this ticket did — this asserts the ONE class choice that
  // measurement depends on instead. This ticket deliberately does NOT add
  // compensating padding once the grip is gone — see task-row-content.tsx's
  // own doc comment on this button for the measurement (12px is already
  // right; the row itself is 32px too deep, so "restoring" the old inset
  // would overshoot).
  it("the drag handle carries `hidden`, not an unconditional `flex` — issue #309's inset-reclaimed criterion depends on it leaving the flex layout, not merely fading in place at full width", () => {
    renderRow({ task: task({ content: "call mum" }) });

    const handle = screen.getByTestId("task-drag-handle");
    expect(handle).toHaveClass("hidden");
    // Whole-token check, not `className.includes("flex")` — that substring
    // would also match `pointer-fine:flex` itself and pass even if `hidden`
    // were dropped, the exact `touch-pan-y`/`touch-pan-yX` trap this repo's
    // own history already names (task-row-content.tsx's `touch-pan-y`
    // comment).
    expect(handle).not.toHaveClass("flex");
  });

  it("opens the full command menu on right-click", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("listitem"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Edit/ })).toBeInTheDocument();

    // Escaped on the menu itself, not the row — Radix hides the rest of
    // the page from the accessibility tree while an open menu's focus
    // scope is active, so the `<li>` isn't a `listitem` to query against
    // until the menu closes again.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /**
   * `fireEvent.contextMenu` on its own dispatches a plain `MouseEvent`
   * (testing-library's own default for that event name), which has no
   * `pointerType` at all — a raw `PointerEvent`, dispatched directly, is
   * what actually reproduces Android's own long-press → contextmenu
   * translation (this file's own `onContextMenu` comment, task-row.tsx,
   * carries the on-device evidence for why that's what arrives there).
   */
  function touchContextMenu(target: Element, pointerId = 15) {
    fireEvent(
      target,
      new PointerEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        pointerId,
      }),
    );
  }

  // Issue #308: a touch long-press on a row that CAN be lifted must not
  // also pop the command menu — that's the whole point of arming a lift
  // instead. `onLongPressArm` defined is what marks this row as one of
  // those (mirrors every other "all seven together" drag prop already
  // does, TaskRowProps' own header comment).
  it("does not open the command menu from a touch contextmenu on a row that has a lift to arm", () => {
    renderRow({ task: task({ content: "call mum" }), onLongPressArm: vi.fn() });

    touchContextMenu(screen.getByRole("listitem"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // A row with no drag handlers at all (Today's own rows) has no lift to
  // arm — this keeps today's behaviour rather than removing the only
  // touch door onto its own command menu ahead of #309.
  it("still opens the command menu from a touch contextmenu on a row with no lift to arm", () => {
    renderRow({ task: task({ content: "call mum" }), onLongPressArm: undefined });

    touchContextMenu(screen.getByRole("listitem"));

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // Right-click and the `.` key must still open the menu on a pointer
  // device (this ticket's own acceptance criterion) — a real right-click
  // reports `button: 2` on a plain `MouseEvent`, never a `pointerType` at
  // all, so the touch-only gate above never engages for it. Distinct from
  // "opens the full command menu on right-click" above only in that it
  // pins the row IS otherwise lift-armable, since that's the case the
  // gate could plausibly have broken.
  it("still opens the command menu on a genuine right-click even when the row has a lift to arm", () => {
    renderRow({ task: task({ content: "call mum" }), onLongPressArm: vi.fn() });

    fireEvent.contextMenu(screen.getByRole("listitem"));

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // Issue #228: the `.` key itself moved off this row entirely, onto
  // `use-todo-keymap.ts`'s one document-level listener — this row's own
  // remaining job is reacting to *that* hook's event, which is what this
  // test drives directly rather than a raw "." keydown (there's no keydown
  // handler left on this row to receive one).
  it("opens the full command menu when use-todo-keymap.ts's own event names this Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new CustomEvent(OPEN_COMMAND_MENU_EVENT, { detail: { taskId: "1" } }));
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("ignores use-todo-keymap.ts's own event when it names a different Task", () => {
    renderRow({ task: task({ id: "1", content: "call mum" }) });

    act(() => {
      document.dispatchEvent(
        new CustomEvent(OPEN_COMMAND_MENU_EVENT, { detail: { taskId: "other-task" } }),
      );
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows no schedule summary for a Task with no date, deadline or priority set", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.queryByText(/Due/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^P[1-4]$/)).not.toBeInTheDocument();
  });

  // Issue #376: a deadline value renders nothing here even when set — a
  // Restore from an old backup can reinject one, but there is no "Due …"
  // badge left to show it in. Date and priority summarise exactly as they
  // would if the Task carried no deadline at all.
  it("summarises an all-day date, ignoring a deadline — a non-default priority renders no text badge", () => {
    renderRow({
      task: task({
        content: "call mum",
        date: "2026-09-03",
        deadline: "2026-09-10",
        priority: 4, // stored 4 is UI P1 — uiPriorityOf's own inversion.
      }),
    });

    expect(screen.getByText("3 Sep")).toBeInTheDocument();
    expect(screen.queryByText(/Due/)).not.toBeInTheDocument();
    expect(screen.queryByText("P1")).not.toBeInTheDocument();
  });

  it("summarises a timed date with its time of day", () => {
    renderRow({ task: task({ content: "call mum", date: "2026-09-03T09:30" }) });

    expect(screen.getByText("3 Sep 9:30 AM")).toBeInTheDocument();
  });

  it("shows a calendar icon beside the date text", () => {
    renderRow({ task: task({ content: "call mum", date: "2026-09-03" }) });

    const dateText = screen.getByText("3 Sep");
    expect(dateText.querySelector("svg.lucide-calendar")).not.toBeNull();
  });

  it("a suppressed date badge on a recurring Task still shows an icon-only recurrence glyph", () => {
    renderRow({
      task: task({ content: "water plants", date: "2026-09-02", dateString: "every day" }),
      suppressDateBadge: true,
    });

    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    expect(screen.queryByText(/↻/)).not.toBeInTheDocument();
    expect(rowBox().querySelector("svg.lucide-repeat")).not.toBeNull();
    expect(rowBox().querySelector("svg.lucide-calendar")).toBeNull();
  });

  it("a suppressed date badge on a non-recurring Task still renders nothing", () => {
    renderRow({
      task: task({ content: "call mum", date: "2026-09-02" }),
      suppressDateBadge: true,
    });

    expect(rowBox().querySelector("svg.lucide-repeat")).toBeNull();
    expect(rowBox().querySelector("svg.lucide-calendar")).toBeNull();
  });

  describe("row height follows whether the row has a metadata line", () => {
    it("lays the 44px row actions out at 36px so they cannot hold a title-only row above 43px", () => {
      renderRow({ task: task({ content: "call mum" }) });

      const more = screen.getByRole("button", { name: 'More actions for "call mum"' });
      expect(more).toHaveClass("size-11", "-my-1");
    });

    it("floors a title-only row at 43px", () => {
      renderRow({ task: task({ content: "call mum" }) });

      expect(rowBox().style.minHeight).toBe("43px");
    });

    it("floors a row with a date badge at 59px", () => {
      renderRow({ task: task({ content: "call mum", date: "2026-09-03" }) });

      expect(rowBox().style.minHeight).toBe("59px");
    });

    it("floors a row with a non-default priority (and no date) at 43px — priority is not metadata", () => {
      renderRow({ task: task({ content: "call mum", priority: 4 }) });

      expect(rowBox().style.minHeight).toBe("43px");
    });

    it("floors a row whose only metadata is a sub-task count at 59px", () => {
      renderRow({ task: task({ content: "call mum" }), subtaskCount: 2 });

      expect(rowBox().style.minHeight).toBe("59px");
    });

    it("floors a row at 43px when its date badge is suppressed and nothing else qualifies as metadata", () => {
      renderRow({
        task: task({ content: "call mum", date: "2026-09-03" }),
        suppressDateBadge: true,
      });

      expect(rowBox().style.minHeight).toBe("43px");
    });
  });

  // Issue #224's own "must gain" list: Labels, the Project a Task lives
  // in, a Description preview and a sub-task count, none of which this
  // row rendered before.
  describe("issue #224's new metadata — Labels, Project, Description, sub-tasks", () => {
    it("shows every resolved Label as a dot-plus-name badge, skipping a dangling id it can't resolve", () => {
      renderRow({
        task: task({ content: "call mum", labelIds: ["label-1", "gone"] }),
        detailActions: {
          projects: [],
          labels: [label({ id: "label-1", name: "urgent" })],
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
      });

      expect(screen.getByText("urgent")).toBeInTheDocument();
    });

    it("shows the Task's own Project name when it has one, resolved live off detailActions.projects", () => {
      renderRow({
        task: task({ content: "call mum", projectId: "project-1" }),
        detailActions: {
          projects: [project({ id: "project-1", name: "Errands" })],
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
      });

      expect(screen.getByText("Errands")).toBeInTheDocument();
    });

    it("shows no Project name for an Inbox Task (projectId null)", () => {
      renderRow({ task: task({ content: "call mum", projectId: null }) });

      // "Inbox" is never named on the row itself — only a Task actually
      // filed under a Project gets the badge (task-schedule-chips.tsx's
      // own `projectNameFor` precedent for the identical omission).
      expect(screen.queryByText("Inbox")).not.toBeInTheDocument();
    });

    it("hides the Project badge when suppressProjectBadge is set, even though the Task has a Project", () => {
      renderRow({
        task: task({ content: "call mum", projectId: "project-1" }),
        suppressProjectBadge: true,
        detailActions: {
          projects: [project({ id: "project-1", name: "Errands" })],
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
      });

      expect(screen.queryByText("Errands")).not.toBeInTheDocument();
    });

    it("still shows the Project badge when suppressProjectBadge is omitted (Today/Upcoming's own default)", () => {
      renderRow({
        task: task({ content: "call mum", projectId: "project-1" }),
        detailActions: {
          projects: [project({ id: "project-1", name: "Errands" })],
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
      });

      expect(screen.getByText("Errands")).toBeInTheDocument();
    });

    it("shows no sub-task count when there are none", () => {
      renderRow({ task: task({ content: "call mum" }), subtaskCount: 0 });

      expect(screen.queryByText("3")).not.toBeInTheDocument();
    });

    it("shows sub-task progress as done/total, once there are sub-tasks", () => {
      // Issue #298 changed this from a bare number. It read
      // `listChildren(...).length` — the *active* children — so a parent
      // whose sub-tasks were all finished counted 0 and the badge emptied as
      // work got done. `subtaskCount` is now the total and `subtaskDone` the
      // finished half; this assertion changed deliberately rather than being
      // relaxed to keep passing.
      renderRow({ task: task({ content: "call mum" }), subtaskCount: 3, subtaskDone: 1 });

      expect(screen.getByText("1/3")).toBeInTheDocument();
      expect(screen.getByText("1 of 3 sub-tasks done")).toBeInTheDocument();
    });

    it("still shows the badge when every sub-task is done", () => {
      renderRow({ task: task({ content: "call mum" }), subtaskCount: 2, subtaskDone: 2 });

      expect(screen.getByText("2/2")).toBeInTheDocument();
    });

    it("previews a Description's first line as rendered markdown beneath the title", () => {
      renderRow({
        task: task({ content: "call mum", description: "**call** first\nthen leave a voicemail" }),
      });

      // Only the first line — the rest of a multi-line Description is one
      // tap away in the detail view, not repeated here (this row's own
      // header comment on `descriptionFirstLine`).
      expect(screen.queryByText(/voicemail/)).not.toBeInTheDocument();
      const strong = screen.getByText("call", { selector: "strong" });
      expect(strong).toBeInTheDocument();
    });

    it("renders no Description preview at all when the Task has none", () => {
      renderRow({ task: task({ content: "call mum", description: null }) });

      expect(document.querySelector(".truncate.text-muted-foreground")).not.toBeInTheDocument();
    });
  });

  describe("comment count — issue #180", () => {
    it("shows no comment count when there are none", () => {
      renderRow({ task: task({ content: "call mum" }), commentCount: 0 });

      expect(screen.queryByText("0")).not.toBeInTheDocument();
    });

    it("shows the count next to the date chip when non-zero", () => {
      renderRow({
        task: task({ content: "call mum", date: "2026-09-03" }),
        commentCount: 3,
      });

      expect(screen.getByText("3 Sep")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("shows the count even on a Task with no date, deadline or priority", () => {
      renderRow({ task: task({ content: "call mum" }), commentCount: 1 });

      expect(screen.getByText("1")).toBeInTheDocument();
    });

    it("renders the comment badge as a link to the Task's own detail route, carrying the reply intent, singular wording at 1", () => {
      renderRow({ task: task({ id: "1", content: "call mum" }), commentCount: 1 });

      const link = screen.getByRole("link", { name: "1 comment" });
      expect(link).toHaveAttribute("href", "/todo/task/call-mum-1?intent=reply");
    });

    it("pluralises the comment badge's wording above 1", () => {
      renderRow({ task: task({ id: "1", content: "call mum" }), commentCount: 2 });

      expect(screen.getByRole("link", { name: "2 comments" })).toBeInTheDocument();
    });

    it("clicking the comment badge never completes the Task", () => {
      // This row carries no click handler of its own today (only the
      // checkbox and the title button call `onComplete`/`onOpenDetail`),
      // so there is nothing live for a bubbled click to accidentally
      // trigger yet — this pins that a click on the link stays a plain
      // navigation, not a second door onto completing the row, should one
      // ever get added. The link's own `stopPropagation` (task-row-content.tsx)
      // is the guard; a real ambient row handler is a browser-only proof
      // (jsdom's root-delegated event model can't stand in for one, see
      // this file's own report).
      const onComplete = vi.fn();
      renderRow({ task: task({ id: "1", content: "call mum" }), commentCount: 1, onComplete });

      fireEvent.click(screen.getByRole("link", { name: "1 comment" }));

      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  // Issue #169's Today view is the first caller with no drag handlers at
  // all — TaskRow's own doc comment on onHandlePointerDown explains why an
  // inert handle would be worse than none.
  // Issue #171: moving a Task between Sections without needing the
  // pointer recogniser's own drag geometry (task-row.tsx's own doc
  // comment on `sectionOptions` names why that gap exists).
  it("offers a Section select only when sectionOptions is given, and calls onMoveToSection", () => {
    const onMoveToSection = vi.fn();
    renderRow({
      task: task({ content: "call mum", sectionId: "s1" }),
      sectionOptions: [
        { id: "s1", name: "Errands" },
        { id: "s2", name: "Later" },
      ],
      onMoveToSection,
    });

    const select = screen.getByRole("combobox", { name: 'Move "call mum" to a Section' });
    expect(select).toHaveValue("s1");

    fireEvent.change(select, { target: { value: "s2" } });
    expect(onMoveToSection).toHaveBeenCalledWith("s2");

    fireEvent.change(select, { target: { value: "" } });
    expect(onMoveToSection).toHaveBeenCalledWith(null);
  });

  it("renders no Section select when sectionOptions is not given", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(
      screen.queryByRole("combobox", { name: 'Move "call mum" to a Section' }),
    ).not.toBeInTheDocument();
  });

  it("renders no drag handle when no drag handlers are given", () => {
    renderRow({
      onHandlePointerDown: undefined,
      onHandlePointerMove: undefined,
      onHandlePointerUp: undefined,
      onHandlePointerCancel: undefined,
    });

    expect(screen.queryByTestId("task-drag-handle")).not.toBeInTheDocument();
  });

  // Issue #192's own acceptance criterion, pinned at the level that
  // actually owns the `<li>`: whatever `children` this row is given (a
  // sub-task's own nested `TaskTree`, in practice — task-tree.tsx's own
  // `TaskTreeRow`) has to land *inside* this row's own `<li>`, not beside
  // it, or the markup is invalid HTML again (a `ul` may hold only `li`).
  // A plain `<ul>` stands in for the real `TaskTree` here — this test
  // only needs to know where `TaskRow` puts whatever it's handed, not
  // whether a real sub-task list renders correctly, which task-tree.test.tsx's
  // own structural test already covers end to end.
  it("renders children inside its own <li>, not as a sibling of it", () => {
    renderRow({
      task: task({ content: "plan trip" }),
      children: (
        <ul data-testid="fake-subtasks">
          <li>book flights</li>
        </ul>
      ),
    });

    // `rowBox()`'s own `<li>` — not `screen.getByRole("listitem")`, which
    // would now also match the fake sub-task `<li>` this test hands in as
    // `children`, and fail on being asked for exactly one of two.
    const li = rowBox().closest("li");
    const subtasks = screen.getByTestId("fake-subtasks");
    expect(li).not.toBeNull();
    expect(li?.contains(subtasks)).toBe(true);
    expect(subtasks.parentElement).toBe(li);
  });

  // Issue #225: inline row editing, which did not exist before this
  // ticket. The activation gesture is Todoist's own measured "Edit"
  // hover pencil (`task-row-content.tsx`'s own header comment records
  // driving it directly) — a single click on the title keeps its
  // pre-existing, unambiguous meaning, "open the detail view."
  describe("inline rename (issue #225)", () => {
    it("clicking Edit swaps the title for the shared editor, seeded with the current content", async () => {
      renderRow({ task: task({ content: "buy milk" }) });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));

      expect(await screen.findByLabelText("Task name")).toHaveValue("buy milk");
      expect(screen.queryByRole("button", { name: "buy milk" })).not.toBeInTheDocument();
    });

    it("a plain click on the title still opens the detail view, unambiguously and with no delay", () => {
      const onOpenDetail = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
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

      fireEvent.click(screen.getByRole("button", { name: "buy milk" }));

      expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ content: "buy milk" }));
    });

    it("Enter commits a changed title through detailActions.onRename, and returns to the display button", async () => {
      const onRename = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
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
          onRename,
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
      const editor = await screen.findByLabelText("Task name");
      fireEvent.change(editor, { target: { value: "buy oat milk" } });
      fireEvent.keyDown(editor, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("1", "buy oat milk");
      // `onRename` here is a bare mock, not a store mutation — this row's
      // own `task` prop never actually changes, so what returns at rest
      // is the display button showing that same, still-current prop
      // (`todo-page.tsx`'s real `renameTask` is what a reader would see
      // reflect the new text, once the store round-trips it back down).
      // What this test can prove at this isolation level is that editing
      // ends and the shared editor unmounts.
      expect(await screen.findByRole("button", { name: "buy milk" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Task name")).not.toBeInTheDocument();
    });

    it("does not rename when the committed text is unchanged or blank", async () => {
      const onRename = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
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
          onRename,
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
      let editor = await screen.findByLabelText("Task name");
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onRename).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: 'Edit "buy milk"' }));
      editor = await screen.findByLabelText("Task name");
      fireEvent.change(editor, { target: { value: "   " } });
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onRename).not.toHaveBeenCalled();
    });

    it("Escape cancels without renaming, discarding the in-progress edit", async () => {
      const onRename = vi.fn();
      renderRow({
        task: task({ content: "buy milk" }),
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
          onRename,
          commentCountFor: vi.fn(() => 0),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: 'Edit "buy milk"' }));
      const editor = await screen.findByLabelText("Task name");
      fireEvent.change(editor, { target: { value: "discard me" } });
      fireEvent.keyDown(editor, { key: "Escape" });

      expect(onRename).not.toHaveBeenCalled();
      expect(await screen.findByRole("button", { name: "buy milk" })).toBeInTheDocument();
    });
  });
  describe("issue #303: the swipe contract", () => {
    // `data-swipe-target` alone does nothing. `use-swipe-actions.ts` reads
    // pointer events, and without `touch-action: pan-y` the browser's own
    // compositor claims the horizontal axis for panning and ends the sequence
    // in `pointercancel` before the recogniser's threshold is reached.
    // `entry-bubble.tsx` — the only other caller of that recogniser — carries
    // the identical class, and `swipe-recognizer.ts:194` names it as the
    // reason its arithmetic holds.
    //
    // This shipped without it. Driven on the device 2026-09-15: the row
    // computed `touch-action: auto` and no left swipe ever opened the
    // scheduler, while every jsdom test stayed green — jsdom has no
    // compositor, so it can never observe the cancel. This test is therefore
    // a class-name assertion on purpose: it guards the half of the contract
    // that a unit test is structurally incapable of exercising.
    it("puts touch-pan-y on the same element that carries the swipe target", () => {
      renderRow();
      const box = rowBox();

      expect(box).toHaveAttribute("data-swipe-target");
      // `classList.contains`, never `className.toContain`. The substring form
      // passes for `touch-pan-yX` — caught here by a mutation that was
      // supposed to fail and didn't, which is the same "a check broad enough
      // to match two subjects cannot fail loudly" shape this file's own
      // breakpoint notes warn about, reproduced inside the test written to
      // guard against it.
      expect(box.classList.contains("touch-pan-y")).toBe(true);
    });
  });
});
