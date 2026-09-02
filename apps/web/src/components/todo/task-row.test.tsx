import type { Task } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskRow } from "./task-row";

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
    // same default packages/core/src/test-support/task-fixture.ts uses,
    // so a test that wants a scheduled Task says so explicitly via
    // `overrides` rather than this fixture guessing at one.
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

function renderRow(overrides: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const props = {
    task: task(),
    detailActions: {
      projects: [],
      labels: [],
      onOpenDetail: vi.fn(),
      onSetPriority: vi.fn(),
      onSetProject: vi.fn(),
      onSetLabels: vi.fn(),
      onCopyLink: vi.fn(),
    },
    onComplete: vi.fn(),
    onCompleteForever: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
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
  );
  return props;
}

describe("TaskRow", () => {
  it("renders the Task's content, with the checkbox unticked", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.getByText("call mum")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "call mum" })).not.toBeChecked();
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

  // The handle only — a pointerdown anywhere else on the row must still let
  // the browser scroll the list normally on touch, which is the entire
  // reason the handle exists as a separate element rather than the row
  // being draggable outright.
  it("does not put pointer listeners on the row itself, only on the handle", () => {
    const onHandlePointerDown = vi.fn();
    renderRow({ onHandlePointerDown });

    fireEvent.pointerDown(screen.getByText("buy milk"), { pointerId: 1 });

    expect(onHandlePointerDown).not.toHaveBeenCalled();
  });

  it("draws the drop indicator only while it is the drop target", () => {
    renderRow({ isDropTarget: true });

    expect(screen.getByRole("listitem")).toHaveClass("border-t-primary");
  });

  // Issue #171's drag-to-reparent: nesting draws a genuinely different
  // indicator from ordinary reordering, not the same top border reused —
  // a reader mid-drag has to be able to tell "lands between rows" from
  // "lands inside this row" without waiting to see what happens on
  // release (this ticket's own brief names conflating the two as a real
  // risk).
  it("draws a distinct row-highlight indicator, not the reorder line, while it is the nest target", () => {
    renderRow({ isNestTarget: true });

    const row = screen.getByRole("listitem");
    expect(row).toHaveClass("ring-primary");
    expect(row).not.toHaveClass("border-t-primary");
  });

  it("draws neither indicator when the row is neither the reorder nor the nest target", () => {
    renderRow({ isDropTarget: false, isNestTarget: false });

    const row = screen.getByRole("listitem");
    expect(row).not.toHaveClass("border-t-primary");
    expect(row).not.toHaveClass("ring-primary");
  });

  // Issue #169: the schedule button is the one door onto Date/Deadline/
  // Duration/Priority pickers from any row, in either Inbox or Today
  // (TaskRow's own doc comment on `onOpenSchedule`).
  // "Schedule" was renamed "Date" (issue #178's own reference behaviour —
  // the row's four hover actions read Edit, Date, Comment, More).
  it("the Date button calls onOpenSchedule", () => {
    const onOpenSchedule = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onOpenSchedule });

    fireEvent.click(screen.getByRole("button", { name: 'Date "call mum"' }));

    expect(onOpenSchedule).toHaveBeenCalledTimes(1);
  });

  it("hovering a row reveals its actions in the fixed order Edit, Date, Comment, More", () => {
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

  it('opens the full command menu on right-click, and on the "." key', () => {
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

    fireEvent.keyDown(screen.getByRole("listitem"), { key: "." });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("shows no schedule summary for a Task with no date, deadline or priority set", () => {
    renderRow({ task: task({ content: "call mum" }) });

    expect(screen.queryByText(/Due/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^P[1-4]$/)).not.toBeInTheDocument();
  });

  it("summarises an all-day date, a deadline and a non-default priority", () => {
    renderRow({
      task: task({
        content: "call mum",
        date: "2026-09-03",
        deadline: "2026-09-10",
        priority: 4, // stored 4 is UI P1 — uiPriorityOf's own inversion.
      }),
    });

    expect(screen.getByText("Sep 3")).toBeInTheDocument();
    expect(screen.getByText("Due Sep 10")).toBeInTheDocument();
    expect(screen.getByText("P1")).toBeInTheDocument();
  });

  it("summarises a timed date with its time of day", () => {
    renderRow({ task: task({ content: "call mum", date: "2026-09-03T09:30" }) });

    expect(screen.getByText("Sep 3, 9:30 AM")).toBeInTheDocument();
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
});
