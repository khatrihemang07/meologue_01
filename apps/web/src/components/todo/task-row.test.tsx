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
    ...overrides,
  };
}

function renderRow(overrides: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const props = {
    task: task(),
    onComplete: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenSchedule: vi.fn(),
    isDropTarget: false,
    onHandlePointerDown: vi.fn(),
    onHandlePointerMove: vi.fn(),
    onHandlePointerUp: vi.fn(),
    onHandlePointerCancel: vi.fn(),
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

  it("the delete button calls onRequestDelete, not the store directly", () => {
    const onRequestDelete = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onRequestDelete });

    fireEvent.click(screen.getByRole("button", { name: 'Delete "call mum"' }));

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

  // Issue #169: the schedule button is the one door onto Date/Deadline/
  // Duration/Priority pickers from any row, in either Inbox or Today
  // (TaskRow's own doc comment on `onOpenSchedule`).
  it("the schedule button calls onOpenSchedule", () => {
    const onOpenSchedule = vi.fn();
    renderRow({ task: task({ content: "call mum" }), onOpenSchedule });

    fireEvent.click(screen.getByRole("button", { name: 'Schedule "call mum"' }));

    expect(onOpenSchedule).toHaveBeenCalledTimes(1);
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
