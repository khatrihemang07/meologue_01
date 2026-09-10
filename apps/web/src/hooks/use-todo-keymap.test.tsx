import type { Task } from "@meologue/core";
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_COMMAND_MENU_EVENT } from "@/lib/todo-keymap";
import { type UseTodoKeymapOptions, useTodoKeymap } from "./use-todo-keymap";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    deviceId: "device-a",
    content: "buy milk",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
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

/** A focused Task row — `focusedTaskId()` (`@/lib/todo-keymap`) reads this off `document.activeElement`'s nearest `[data-task-id]` ancestor, exactly as `task-row.tsx`'s own `<li data-task-id>` renders it. */
function focusTaskRow(taskId: string): HTMLElement {
  const row = document.createElement("li");
  row.setAttribute("data-task-id", taskId);
  const button = document.createElement("button");
  row.append(button);
  document.body.append(row);
  button.focus();
  return row;
}

function renderKeymap(overrides: Partial<UseTodoKeymapOptions> = {}) {
  const options: UseTodoKeymapOptions = {
    resolveTask: (taskId) => (taskId === "task-1" ? task() : null),
    onOpenTaskDetail: vi.fn(),
    onOpenSchedule: vi.fn(),
    onSetTaskDate: vi.fn(),
    onSetTaskDeadline: vi.fn(),
    onRequestDelete: vi.fn(),
    onOpenQuickFind: vi.fn(),
    onShowShortcuts: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
  renderHook(() => useTodoKeymap(options));
  return options;
}

describe("useTodoKeymap", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens Quick Find on '/', 'f' and Ctrl+K", () => {
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "/" });
    fireEvent.keyDown(document, { key: "f" });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(options.onOpenQuickFind).toHaveBeenCalledTimes(3);
  });

  it("does not open Quick Find on '/' or 'f' while typing in a text field, but Ctrl+K still fires", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const options = renderKeymap();

    fireEvent.keyDown(input, { key: "/" });
    fireEvent.keyDown(input, { key: "f" });
    expect(options.onOpenQuickFind).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(options.onOpenQuickFind).toHaveBeenCalledTimes(1);
  });

  it("shows the shortcuts overlay on '?'", () => {
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "?" });

    expect(options.onShowShortcuts).toHaveBeenCalledTimes(1);
  });

  it("dispatches the command-menu event naming the focused Task on '.'", () => {
    focusTaskRow("task-1");
    renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_COMMAND_MENU_EVENT, listener);

    fireEvent.keyDown(document, { key: "." });

    expect(listener).toHaveBeenCalledTimes(1);
    const receivedEvent = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(receivedEvent.detail).toEqual({ taskId: "task-1" });
    document.removeEventListener(OPEN_COMMAND_MENU_EVENT, listener);
  });

  it("does nothing on '.' when no Task row has focus", () => {
    renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_COMMAND_MENU_EVENT, listener);

    fireEvent.keyDown(document, { key: "." });

    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener(OPEN_COMMAND_MENU_EVENT, listener);
  });

  it("opens the focused Task's detail view on Cmd/Ctrl+E", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "e", metaKey: true });

    expect(options.onOpenTaskDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
    );
  });

  it("opens the schedule sheet for the focused Task on T, D and Y", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "t" });
    fireEvent.keyDown(document, { key: "d" });
    fireEvent.keyDown(document, { key: "y" });

    expect(options.onOpenSchedule).toHaveBeenCalledTimes(3);
    expect(options.onOpenSchedule).toHaveBeenCalledWith("task-1");
  });

  it("clears the focused Task's Date/Deadline on Shift+T / Shift+D", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "T", shiftKey: true });
    fireEvent.keyDown(document, { key: "D", shiftKey: true });

    expect(options.onSetTaskDate).toHaveBeenCalledWith("task-1", null);
    expect(options.onSetTaskDeadline).toHaveBeenCalledWith("task-1", null);
  });

  it("requests deletion of the focused Task on Cmd+Backspace or Shift+Delete", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "Backspace", metaKey: true });
    expect(options.onRequestDelete).toHaveBeenCalledWith("task-1");

    options.onRequestDelete = vi.fn();
    fireEvent.keyDown(document, { key: "Delete", shiftKey: true });
  });

  it("does nothing for a task-focused binding when no Task row has focus", () => {
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "t" });
    fireEvent.keyDown(document, { key: "e", metaKey: true });

    expect(options.onOpenSchedule).not.toHaveBeenCalled();
    expect(options.onOpenTaskDetail).not.toHaveBeenCalled();
  });

  it("navigates on the G-then-key sequences", () => {
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "t" });
    expect(options.onNavigate).toHaveBeenCalledWith("/todo/today");

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "i" });
    expect(options.onNavigate).toHaveBeenCalledWith("/todo/inbox");
  });

  it("a bare 'g' alone navigates nowhere, and a standalone 't' still opens the schedule sheet once the sequence is consumed", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "g" });
    expect(options.onNavigate).not.toHaveBeenCalled();

    // Completes the "g t" sequence — go to Today, not "set date".
    fireEvent.keyDown(document, { key: "t" });
    expect(options.onNavigate).toHaveBeenCalledWith("/todo/today");
    expect(options.onOpenSchedule).not.toHaveBeenCalled();

    // A later, standalone "t" — no preceding "g" this time — hits the
    // ordinary "set date" binding instead.
    fireEvent.keyDown(document, { key: "t" });
    expect(options.onOpenSchedule).toHaveBeenCalledWith("task-1");
  });

  it("clears the pending sequence on a non-matching second key, firing nothing", () => {
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "z" });

    expect(options.onNavigate).not.toHaveBeenCalled();
  });

  it("clears the pending sequence on timeout", () => {
    vi.useFakeTimers();
    try {
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "g" });
      vi.advanceTimersByTime(1100);
      fireEvent.keyDown(document, { key: "t" });

      expect(options.onNavigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores Alt-held keys entirely", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "t", altKey: true });

    expect(options.onOpenSchedule).not.toHaveBeenCalled();
  });
});
