import type { Task } from "@meologue/core";
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_COMMAND_MENU_EVENT,
  OPEN_QUICK_ADD_EVENT,
  OPEN_SCHEDULE_EVENT,
} from "@/lib/todo-keymap";
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

/** An incomplete row for row-to-row navigation tests — mirrors task-row-content.tsx's own `[data-row-nav-target]` title button inside task-row.tsx's `<li data-task-id>`. */
function renderTaskRow(taskId: string, title: string): HTMLButtonElement {
  const li = document.createElement("li");
  li.setAttribute("data-task-id", taskId);
  const button = document.createElement("button");
  button.setAttribute("data-row-nav-target", "");
  button.textContent = title;
  li.append(button);
  document.body.append(li);
  return button;
}

/** The "Add task" affordance's own live focusable descendant — mirrors add-task-form.tsx's `[data-add-task-field]` wrapper around `TaskTitleEditor`'s `role="textbox"` div. */
function renderAddTaskField(): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-add-task-field", "");
  const field = document.createElement("div");
  field.setAttribute("role", "textbox");
  field.tabIndex = 0;
  wrapper.append(field);
  document.body.append(wrapper);
  return field;
}

/** A completed row inside a collapsed-by-default `<details>` — mirrors completed-tasks.tsx exactly, including the disclosure defaulting closed, since that is precisely what `focusAdjacentRow` (todo-keymap.ts) has to open before a landing there is real rather than jsdom-only. Reuses one `<details>` across calls in the same test, matching the single disclosure `CompletedTasks` itself renders. */
function renderCompletedRow(title: string): {
  restoreButton: HTMLButtonElement;
  details: HTMLDetailsElement;
} {
  let details = document.querySelector("details");
  if (details === null) {
    details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Completed";
    details.append(summary);
    document.body.append(details);
  }
  const li = document.createElement("li");
  const restoreButton = document.createElement("button");
  restoreButton.setAttribute("data-row-nav-target", "");
  restoreButton.setAttribute("aria-label", `Restore "${title}"`);
  li.append(restoreButton);
  details.append(li);
  return { restoreButton, details: details as HTMLDetailsElement };
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
    onUndoComplete: vi.fn(),
    onCompleteTask: vi.fn(),
    onCopyLink: vi.fn(),
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

  // CMT-05 (parity ledger) — `docs/reference/todoist/keyboard.md:74`
  // transcribes Todoist's own overlay row as "Z or ⌘Z | Undo", so both
  // keys fire the identical `onUndoComplete` door; this hook itself has
  // no notion of "what's pending" beyond calling that one callback
  // unconditionally (`todo-page.tsx`'s own pending-undo ref decides
  // whether there's anything to do).
  describe("undo (CMT-05)", () => {
    it("calls onUndoComplete on 'z'", () => {
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "z" });

      expect(options.onUndoComplete).toHaveBeenCalledTimes(1);
    });

    it("calls onUndoComplete on Cmd+Z", () => {
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "z", metaKey: true });

      expect(options.onUndoComplete).toHaveBeenCalledTimes(1);
    });

    // Nothing here for this hook to no-op on directly — `onUndoComplete`
    // always fires; a "nothing undoable" world is the caller's own
    // no-op to make (`todo-page.tsx`'s pending-undo ref is `null`). What
    // this asserts is the hook's half of that contract: it never
    // second-guesses whether there's something to undo, so a caller
    // wired to do nothing when nothing is pending sees exactly that,
    // and nothing more.
    it("still calls onUndoComplete when the caller has nothing pending — the hook itself never withholds the call", () => {
      const onUndoComplete = vi.fn();
      renderKeymap({ onUndoComplete });

      fireEvent.keyDown(document, { key: "z" });
      fireEvent.keyDown(document, { key: "z", metaKey: true });

      expect(onUndoComplete).toHaveBeenCalledTimes(2);
    });

    // The highest-risk part of CMT-05: a reader typing a task title (or
    // anything else) and pressing Cmd+Z must get their text back, not an
    // unrelated completion undone. `isTypingTarget` plus this binding's
    // default `allowInField: false` is what's supposed to guarantee
    // that — proved here rather than assumed. An `<input>` stands in for
    // the composer: jsdom does not implement `HTMLElement.
    // isContentEditable` at all (it reads `undefined`, not `false`), so
    // a jsdom test cannot exercise the contenteditable arm of
    // `isTypingTarget` — that arm (the Add-task/description composers)
    // is verified on screen only, not here.
    it("does not fire inside a text field, on 'z' or Cmd+Z", () => {
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      const options = renderKeymap();

      fireEvent.keyDown(input, { key: "z" });
      fireEvent.keyDown(input, { key: "z", metaKey: true });

      expect(options.onUndoComplete).not.toHaveBeenCalled();
    });

    it("does not fire inside a textarea, on 'z' or Cmd+Z", () => {
      const textarea = document.createElement("textarea");
      document.body.append(textarea);
      textarea.focus();
      const options = renderKeymap();

      fireEvent.keyDown(textarea, { key: "z" });
      fireEvent.keyDown(textarea, { key: "z", metaKey: true });

      expect(options.onUndoComplete).not.toHaveBeenCalled();
    });
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

  // Issue #260 (NAV-07/KBD-01, parity ledger): `Q` opens the global Quick
  // Add dialog, dispatched as a bare document event (no `taskId` detail,
  // unlike `command-menu`/`set-date` above) since `todo-page.tsx` is the
  // one listener regardless of what, if anything, is focused.
  it("dispatches OPEN_QUICK_ADD_EVENT on 'q'", () => {
    renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_QUICK_ADD_EVENT, listener);

    fireEvent.keyDown(document, { key: "q" });

    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener(OPEN_QUICK_ADD_EVENT, listener);
  });

  it("does not dispatch OPEN_QUICK_ADD_EVENT for 'q' typed into a text field", () => {
    renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_QUICK_ADD_EVENT, listener);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    fireEvent.keyDown(input, { key: "q" });

    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener(OPEN_QUICK_ADD_EVENT, listener);
  });

  it("opens the focused Task's detail view on Cmd/Ctrl+E", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "e", metaKey: true });

    expect(options.onOpenTaskDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
    );
  });

  // Issue #253: `T` no longer opens the shared schedule sheet directly —
  // it dispatches `OPEN_SCHEDULE_EVENT` instead, the identical
  // document-level fan-in `OPEN_COMMAND_MENU_EVENT` already uses for `.`
  // (todo-keymap.ts's own doc comment on why), so a row's own anchored
  // `TaskSchedulePopover` instance can open regardless of which of the
  // three entry points fired.
  it("dispatches OPEN_SCHEDULE_EVENT naming the focused Task on T", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_SCHEDULE_EVENT, listener);

    fireEvent.keyDown(document, { key: "t" });

    expect(listener).toHaveBeenCalledTimes(1);
    const receivedEvent = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(receivedEvent.detail).toEqual({ taskId: "task-1" });
    expect(options.onOpenSchedule).not.toHaveBeenCalled();
    document.removeEventListener(OPEN_SCHEDULE_EVENT, listener);
  });

  it("does not dispatch OPEN_SCHEDULE_EVENT on T when no Task row has focus", () => {
    renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_SCHEDULE_EVENT, listener);

    fireEvent.keyDown(document, { key: "t" });

    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener(OPEN_SCHEDULE_EVENT, listener);
  });

  it("opens the schedule sheet for the focused Task on D and Y, unchanged (Deadline and Priority still live there)", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "d" });
    fireEvent.keyDown(document, { key: "y" });

    expect(options.onOpenSchedule).toHaveBeenCalledTimes(2);
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

  // KBD-01/KBD-06 (parity ledger) — three missed (b)s: the app-side
  // handlers (`handleCompleteTask`, the Comment button's `onOpenDetail`,
  // `copyTaskLink`) already existed; only the keys were missing.
  describe("missed (b)s found by KBD-01/KBD-06", () => {
    it("completes the focused Task on 'e'", () => {
      focusTaskRow("task-1");
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "e" });

      expect(options.onCompleteTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
      );
    });

    it("does not complete while typing, since 'e' has no allowInField exception", () => {
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      const options = renderKeymap();

      fireEvent.keyDown(input, { key: "e" });

      expect(options.onCompleteTask).not.toHaveBeenCalled();
    });

    it("opens the focused Task's detail view on 'c' (Comment on task)", () => {
      focusTaskRow("task-1");
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "c" });

      expect(options.onOpenTaskDetail).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
      );
    });

    it("copies the focused Task's link on Cmd/Ctrl+Shift+C", () => {
      focusTaskRow("task-1");
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "C", metaKey: true, shiftKey: true });
      expect(options.onCopyLink).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));

      options.onCopyLink = vi.fn();
      fireEvent.keyDown(document, { key: "C", ctrlKey: true, shiftKey: true });
      expect(options.onCopyLink).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
    });

    it("does nothing for 'e', 'c' or Cmd+Shift+C when no Task row has focus", () => {
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "e" });
      fireEvent.keyDown(document, { key: "c" });
      fireEvent.keyDown(document, { key: "C", metaKey: true, shiftKey: true });

      expect(options.onCompleteTask).not.toHaveBeenCalled();
      expect(options.onOpenTaskDetail).not.toHaveBeenCalled();
      expect(options.onCopyLink).not.toHaveBeenCalled();
    });

    it("navigates to Settings on the O-then-S sequence", () => {
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "o" });
      fireEvent.keyDown(document, { key: "s" });

      expect(options.onNavigate).toHaveBeenCalledWith("/settings");
    });

    // Coordinator's own re-audit: the theme picker (`appearance-
    // section.tsx`) lives on the same `/settings` screen, not a separate
    // route — so this shares `go-settings`'s own destination.
    it("navigates to Settings (where the theme picker lives) on the O-then-T sequence", () => {
      const options = renderKeymap();

      fireEvent.keyDown(document, { key: "o" });
      fireEvent.keyDown(document, { key: "t" });

      expect(options.onNavigate).toHaveBeenCalledWith("/settings");
    });

    it("focuses the Add-task field on 'a'", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-add-task-field", "");
      const field = document.createElement("div");
      field.setAttribute("role", "textbox");
      field.tabIndex = 0;
      wrapper.append(field);
      document.body.append(wrapper);
      renderKeymap();

      fireEvent.keyDown(document, { key: "a" });

      expect(document.activeElement).toBe(field);
    });

    it("does not steal 'a' while typing in a text field", () => {
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      renderKeymap();

      fireEvent.keyDown(input, { key: "a" });

      expect(document.activeElement).toBe(input);
    });
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

  // Coordinator's own re-audit found these two wrongly excluded:
  // `/todo/labels` and `/todo/activity` (labelled "Reporting" by
  // `todo-sidebar.tsx`, NAV-01) are both real routes.
  it("navigates to Labels and Activity on the G-then-L and G-then-A sequences", () => {
    const options = renderKeymap();

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "l" });
    expect(options.onNavigate).toHaveBeenCalledWith("/todo/labels");

    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "a" });
    expect(options.onNavigate).toHaveBeenCalledWith("/todo/activity");
  });

  it("a bare 'g' alone navigates nowhere, and a standalone 't' still dispatches OPEN_SCHEDULE_EVENT once the sequence is consumed", () => {
    focusTaskRow("task-1");
    const options = renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_SCHEDULE_EVENT, listener);

    fireEvent.keyDown(document, { key: "g" });
    expect(options.onNavigate).not.toHaveBeenCalled();

    // Completes the "g t" sequence — go to Today, not "set date".
    fireEvent.keyDown(document, { key: "t" });
    expect(options.onNavigate).toHaveBeenCalledWith("/todo/today");
    expect(listener).not.toHaveBeenCalled();

    // A later, standalone "t" — no preceding "g" this time — hits the
    // ordinary "set date" binding instead.
    fireEvent.keyDown(document, { key: "t" });
    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener(OPEN_SCHEDULE_EVENT, listener);
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
    renderKeymap();
    const listener = vi.fn();
    document.addEventListener(OPEN_SCHEDULE_EVENT, listener);

    fireEvent.keyDown(document, { key: "t", altKey: true });

    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener(OPEN_SCHEDULE_EVENT, listener);
  });

  // KBD-03/KBD-04 (parity ledger) — measured live against Todoist
  // (docs/reference/todoist/live-audit-dom/flow6-KBD-03-todoist.json,
  // flow6-KBD-04-todoist.json): both ArrowDown/ArrowUp and j/k move focus
  // row-to-row, wrapping at both ends and walking through the "Add task"
  // affordance and completed rows.
  describe("row-to-row navigation (KBD-03/KBD-04)", () => {
    it("moves focus down on ArrowDown, then down again on 'j'", () => {
      const row1 = renderTaskRow("t1", "Row 1");
      const row2 = renderTaskRow("t2", "Row 2");
      const row3 = renderTaskRow("t3", "Row 3");
      renderKeymap();
      row1.focus();

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(document.activeElement).toBe(row2);

      fireEvent.keyDown(document, { key: "j" });
      expect(document.activeElement).toBe(row3);
    });

    it("moves focus up on ArrowUp, then up again on 'k'", () => {
      const row1 = renderTaskRow("t1", "Row 1");
      const row2 = renderTaskRow("t2", "Row 2");
      const row3 = renderTaskRow("t3", "Row 3");
      renderKeymap();
      row3.focus();

      fireEvent.keyDown(document, { key: "ArrowUp" });
      expect(document.activeElement).toBe(row2);

      fireEvent.keyDown(document, { key: "k" });
      expect(document.activeElement).toBe(row1);
    });

    it("wraps focus from the last row back to the first on ArrowDown", () => {
      const row1 = renderTaskRow("t1", "Row 1");
      const row2 = renderTaskRow("t2", "Row 2");
      renderKeymap();
      row2.focus();

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(document.activeElement).toBe(row1);
    });

    it("wraps focus from the first row back to the last on ArrowUp", () => {
      const row1 = renderTaskRow("t1", "Row 1");
      const row2 = renderTaskRow("t2", "Row 2");
      renderKeymap();
      row1.focus();

      fireEvent.keyDown(document, { key: "ArrowUp" });
      expect(document.activeElement).toBe(row2);
    });

    it("lands on the first row when nothing is focused yet", () => {
      const row1 = renderTaskRow("t1", "Row 1");
      renderTaskRow("t2", "Row 2");
      renderKeymap();
      expect(document.activeElement).toBe(document.body);

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(document.activeElement).toBe(row1);
    });

    it("walks through the Add task affordance and into a completed row, opening its collapsed disclosure, then wraps", () => {
      const row1 = renderTaskRow("t1", "Row 1");
      const addTaskField = renderAddTaskField();
      const { restoreButton, details } = renderCompletedRow("Done task");
      renderKeymap();
      row1.focus();

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(document.activeElement).toBe(addTaskField);

      expect(details.open).toBe(false);
      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(document.activeElement).toBe(restoreButton);
      // Real-browser correctness, not just a jsdom pass: a completed
      // row's own <details> has to actually be open for its Restore
      // button to be focusable at all (todo-keymap.ts's own
      // focusAdjacentRow doc comment has the HTML-spec reasoning).
      expect(details.open).toBe(true);

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(document.activeElement).toBe(row1);
    });

    it("does not move row focus when ArrowDown/ArrowUp is pressed inside a text field", () => {
      renderTaskRow("t1", "Row 1");
      renderTaskRow("t2", "Row 2");
      const input = document.createElement("input");
      document.body.append(input);
      renderKeymap();
      input.focus();

      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(document.activeElement).toBe(input);

      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(document.activeElement).toBe(input);
    });

    it("does not move row focus when ArrowDown/ArrowUp is pressed inside an open dialog/popover", () => {
      renderTaskRow("t1", "Row 1");
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const dialogButton = document.createElement("button");
      dialog.append(dialogButton);
      document.body.append(dialog);
      renderKeymap();
      dialogButton.focus();

      fireEvent.keyDown(dialogButton, { key: "ArrowDown" });
      expect(document.activeElement).toBe(dialogButton);
    });

    /**
     * The Add-task composer's own escape rule (`canLeaveAddTaskField`,
     * todo-keymap.ts) — the focus trap these tests exist because of: arrows
     * could enter the composer from either side and never leave it.
     *
     * **What jsdom cannot check here, stated rather than faked.**
     * `HTMLElement.isContentEditable` is `undefined` in jsdom (probed, not
     * assumed — it is not implemented at all), so `isTypingTarget` never
     * reports a contenteditable as a typing target under test. That is
     * exactly why the trap survived 3287 passing tests: the real composer is
     * a contenteditable `TaskTitleEditor`, and no jsdom test can reach the
     * suppression path it takes. These tests therefore drive the `<input>`
     * arm of `rowNavTargets`'s own selector — real for that arm, and the
     * one jsdom honours — while the contenteditable arm stays verified on
     * screen only. `Range.toString()` boundary probing itself does work in
     * jsdom, so the caret logic below is genuinely exercised.
     */
    describe("leaving the Add-task composer (the focus trap)", () => {
      function renderAddTaskInput(value: string): HTMLInputElement {
        const wrapper = document.createElement("div");
        wrapper.setAttribute("data-add-task-field", "");
        const input = document.createElement("input");
        input.value = value;
        wrapper.append(input);
        document.body.append(wrapper);
        return input;
      }

      it("leaves the composer on ArrowDown when the caret sits at the end", () => {
        const row1 = renderTaskRow("t1", "Row 1");
        const input = renderAddTaskInput("buy milk");
        renderKeymap();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);

        fireEvent.keyDown(input, { key: "ArrowDown" });
        // Wraps past the composer (the last stop here) back to the first row.
        expect(document.activeElement).toBe(row1);
      });

      it("leaves the composer on ArrowUp when the caret sits at the start", () => {
        const row1 = renderTaskRow("t1", "Row 1");
        const input = renderAddTaskInput("buy milk");
        renderKeymap();
        input.focus();
        input.setSelectionRange(0, 0);

        fireEvent.keyDown(input, { key: "ArrowUp" });
        expect(document.activeElement).toBe(row1);
      });

      it("keeps native caret movement when the caret sits mid-text", () => {
        renderTaskRow("t1", "Row 1");
        const input = renderAddTaskInput("buy milk");
        renderKeymap();
        input.focus();
        input.setSelectionRange(3, 3);

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(document.activeElement).toBe(input);

        fireEvent.keyDown(input, { key: "ArrowUp" });
        expect(document.activeElement).toBe(input);
      });

      it("does not leave on an arrow pointing away from the caret's own edge", () => {
        renderTaskRow("t1", "Row 1");
        const input = renderAddTaskInput("buy milk");
        renderKeymap();
        input.focus();
        // Caret at the very end: ArrowUp points at the *other* edge, so it
        // must move the caret natively rather than walk the cycle.
        input.setSelectionRange(input.value.length, input.value.length);

        fireEvent.keyDown(input, { key: "ArrowUp" });
        expect(document.activeElement).toBe(input);
      });

      it("does not leave while text is selected rather than a bare caret", () => {
        renderTaskRow("t1", "Row 1");
        const input = renderAddTaskInput("buy milk");
        renderKeymap();
        input.focus();
        input.setSelectionRange(0, input.value.length);

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(document.activeElement).toBe(input);
      });

      it("fires undo while a CHECKBOX holds focus — the path a reader actually takes", () => {
        // CMT-05's real-world failure: completing a Task by clicking its
        // checkbox leaves focus on that checkbox, and the old
        // `tagName === "INPUT"` guard called that "typing", suppressing the
        // binding so Ctrl/Cmd+Z silently did nothing. A checkbox takes no
        // typed text, so it must not suppress anything.
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        document.body.append(checkbox);
        const props = renderKeymap();
        checkbox.focus();

        fireEvent.keyDown(checkbox, { key: "z" });
        expect(props.onUndoComplete).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(checkbox, { key: "z", metaKey: true });
        expect(props.onUndoComplete).toHaveBeenCalledTimes(2);
      });

      it("still suppresses undo inside a text input and a textarea", () => {
        const text = document.createElement("input");
        text.type = "text";
        const area = document.createElement("textarea");
        document.body.append(text, area);
        const props = renderKeymap();

        text.focus();
        fireEvent.keyDown(text, { key: "z" });
        fireEvent.keyDown(text, { key: "z", metaKey: true });
        area.focus();
        fireEvent.keyDown(area, { key: "z" });
        fireEvent.keyDown(area, { key: "z", metaKey: true });
        expect(props.onUndoComplete).not.toHaveBeenCalled();
      });

      it("treats an input with no type attribute as typing, since it defaults to text", () => {
        const bare = document.createElement("input");
        document.body.append(bare);
        const props = renderKeymap();
        bare.focus();

        fireEvent.keyDown(bare, { key: "z" });
        expect(props.onUndoComplete).not.toHaveBeenCalled();
      });

      it("treats a time input as typing, because its own arrows change its value", () => {
        const time = document.createElement("input");
        time.type = "time";
        document.body.append(time);
        const props = renderKeymap();
        time.focus();

        fireEvent.keyDown(time, { key: "z" });
        expect(props.onUndoComplete).not.toHaveBeenCalled();
      });

      it("never navigates on 'j'/'k', which must stay typeable at any caret position", () => {
        renderTaskRow("t1", "Row 1");
        const input = renderAddTaskInput("");
        renderKeymap();
        input.focus();
        // Empty composer: both edges are satisfied, so this is the position
        // most likely to leak — `jack` and `kite` must still be typeable.
        input.setSelectionRange(0, 0);

        fireEvent.keyDown(input, { key: "j" });
        expect(document.activeElement).toBe(input);

        fireEvent.keyDown(input, { key: "k" });
        expect(document.activeElement).toBe(input);
      });

      it("leaves an empty composer on either arrow, the ordinary case", () => {
        const row1 = renderTaskRow("t1", "Row 1");
        const input = renderAddTaskInput("");
        renderKeymap();
        input.focus();
        input.setSelectionRange(0, 0);

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(document.activeElement).toBe(row1);
      });
    });
  });
});
