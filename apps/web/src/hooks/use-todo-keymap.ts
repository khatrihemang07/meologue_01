import type { Task } from "@meologue/core";
import { useEffect, useRef } from "react";
import {
  canLeaveAddTaskField,
  chordFor,
  focusAdjacentRow,
  focusedTaskId,
  isInsideOverlay,
  isTypingTarget,
  OPEN_COMMAND_MENU_EVENT,
  OPEN_QUICK_ADD_EVENT,
  OPEN_SCHEDULE_EVENT,
  TODO_KEY_BINDINGS,
  type TodoKeyBinding,
} from "@/lib/todo-keymap";

export interface UseTodoKeymapOptions {
  /** Looks a Task up by id — `todo-page.tsx`'s own `tasks`/`completedTasks` two-list lookup (`openTask`'s own doc comment there gives the reason both lists matter), handed in rather than duplicated here. */
  resolveTask: (taskId: string) => Task | null;
  onOpenTaskDetail: (task: Task) => void;
  /** Opens the shared `TaskScheduleSheet` — reached from `D`/`Y` (Deadline/Priority) only, since issue #253 moved `T` (Date) onto `OPEN_SCHEDULE_EVENT` instead (that constant's own doc comment, todo-keymap.ts). */
  onOpenSchedule: (taskId: string) => void;
  onSetTaskDate: (taskId: string, date: string | null) => void;
  onSetTaskDeadline: (taskId: string, deadline: string | null) => void;
  onRequestDelete: (taskId: string) => void;
  onOpenQuickFind: () => void;
  onShowShortcuts: () => void;
  onNavigate: (path: string) => void;
  /**
   * CMT-05 (parity ledger) — fired for `undo-complete` (`Z`/`⌘Z`,
   * `@/lib/todo-keymap`'s own doc comment on that binding has the fuller
   * reasoning). `todo-page.tsx` owns the one thing there is to undo — a
   * ref holding the most recent completion's own `uncompleteTask` call,
   * set when its toast is raised and cleared the moment it is used or the
   * toast closes — and this option is that ref's single door, called
   * unconditionally. When nothing is pending it is `todo-page.tsx`'s own
   * no-op to make, not a lookup this hook performs, matching every other
   * binding here whose target can come back absent (`fire()`'s own
   * `taskId !== null` guards just below).
   */
  onUndoComplete: () => void;
}

// Every sequence's own first key (currently just `"g"`, from `TODO_KEY_
// BINDINGS`'s `"g i"`/`"g t"`/`"g u"`/`"g p"`/`"g v"` rows) — computed once
// from the table itself rather than hard-coded, so a future sequence
// starting on a different key needs no change here.
const SEQUENCE_PREFIXES = new Set(
  TODO_KEY_BINDINGS.flatMap((binding) => binding.keys)
    .filter((key) => key.includes(" "))
    .map((key) => key.split(" ")[0] as string),
);

// How long a `G` press waits for its second key before giving up (issue
// #228's own "cleared on timeout" requirement) — long enough for a
// deliberate two-key press, short enough that a bare `G` typed moments
// apart in, say, a filter query editor's own text (were this hook ever to
// see that keydown, which the typing guard already prevents) couldn't read
// as half a sequence.
const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * Todo's one keyboard listener (issue #228) — mounted once by `todo-
 * page.tsx`, which itself only renders for `/todo/*` (`App.tsx`'s routes),
 * so this unmounts the instant a reader leaves Todo exactly the way `Todo
 * Nav`/the Todo sidebar already do (those files' own header comments).
 *
 * Supersedes three previously-separate mechanisms, all deleted rather than
 * left racing this one: `task-quick-find.tsx`'s own `document.
 * addEventListener("keydown", …)` for `/`/`f`/⌘K, and `task-row.tsx`'s own
 * per-row `onKeyDown` for `.`. One listener, one table (`@/lib/todo-
 * keymap`), one place to add the next binding.
 *
 * `document.activeElement` (via `focusedTaskId()`, todo-keymap.ts) is the
 * single source of truth for "which Task" every `when: "task-focused"`
 * binding acts on — not a second, independently-tracked "selected task"
 * concept. A binding whose focused-task lookup comes back `null` (nothing
 * focused, or focus sits outside any row) does nothing, silently: exactly
 * the same "no affordance for a gesture that can't happen here" posture
 * `task-command-menu.tsx`'s own header comment already takes for absent
 * capabilities, applied here to an absent *target* instead.
 */
export function useTodoKeymap(options: UseTodoKeymapOptions): void {
  // Kept current every render without re-subscribing the listener below —
  // the listener itself is registered once, on mount, so a fresh render
  // (which would otherwise hand it a new `options` object) never has to
  // tear down and rebuild a live two-key sequence mid-press.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let pending: { prefix: string; timeout: ReturnType<typeof setTimeout> } | null = null;

    function clearPending() {
      if (pending !== null) {
        clearTimeout(pending.timeout);
        pending = null;
      }
    }

    function fire(binding: TodoKeyBinding) {
      const opts = optionsRef.current;
      const taskId = focusedTaskId();
      switch (binding.id) {
        case "quick-find":
        case "quick-find-global":
          opts.onOpenQuickFind();
          return;
        case "show-shortcuts":
          opts.onShowShortcuts();
          return;
        // Issue #260: `Q` opens the global Quick Add dialog — a bare
        // document event, the same fan-in `command-menu`/`set-date` below
        // already use, because `todo-page.tsx` (the one place that both
        // mounts this hook and owns `QuickAddDialog`/`handleAdd`) is the
        // only listener; no `onOpenQuickAdd` option was added here on
        // purpose, to keep this hook's own option surface from growing for
        // a call site that already has a working event to dispatch on.
        case "quick-add":
          document.dispatchEvent(new CustomEvent(OPEN_QUICK_ADD_EVENT));
          return;
        case "undo-complete":
          opts.onUndoComplete();
          return;
        // KBD-03/04: row-to-row focus movement — `focusAdjacentRow`
        // (todo-keymap.ts) owns the whole cycle (DOM order, wrap, the
        // "Add task" affordance, completed rows), so this case is a bare
        // fan-out, the same shape every other single-purpose binding here
        // already takes.
        case "focus-next-row":
          focusAdjacentRow("next");
          return;
        case "focus-previous-row":
          focusAdjacentRow("previous");
          return;
        case "command-menu":
          if (taskId !== null) {
            document.dispatchEvent(
              new CustomEvent(OPEN_COMMAND_MENU_EVENT, { detail: { taskId } }),
            );
          }
          return;
        case "edit-task": {
          const task = taskId !== null ? opts.resolveTask(taskId) : null;
          if (task !== null) {
            opts.onOpenTaskDetail(task);
          }
          return;
        }
        // Issue #253: `T` now opens the row's own anchored
        // `TaskSchedulePopover` instance rather than the shared bottom
        // sheet — `OPEN_SCHEDULE_EVENT`'s own doc comment (todo-keymap.ts)
        // has the reasoning for why this fires an event instead of calling
        // `onOpenSchedule` the way `set-deadline`/`set-priority` below
        // still do (the sheet still holds Deadline and Priority, unchanged
        // by this ticket).
        case "set-date":
          if (taskId !== null) {
            document.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId } }));
          }
          return;
        case "set-deadline":
        case "set-priority":
          if (taskId !== null) {
            opts.onOpenSchedule(taskId);
          }
          return;
        case "remove-date":
          if (taskId !== null) {
            opts.onSetTaskDate(taskId, null);
          }
          return;
        case "remove-deadline":
          if (taskId !== null) {
            opts.onSetTaskDeadline(taskId, null);
          }
          return;
        case "delete-task":
          if (taskId !== null) {
            opts.onRequestDelete(taskId);
          }
          return;
        case "open-in-project": {
          const task = taskId !== null ? opts.resolveTask(taskId) : null;
          if (task !== null) {
            opts.onNavigate(
              task.projectId === null ? "/todo/inbox" : `/todo/projects/${task.projectId}`,
            );
          }
          return;
        }
        case "go-inbox":
          opts.onNavigate("/todo/inbox");
          return;
        case "go-today":
          opts.onNavigate("/todo/today");
          return;
        case "go-upcoming":
          opts.onNavigate("/todo/upcoming");
          return;
        case "go-projects":
          opts.onNavigate("/todo/projects");
          return;
        case "go-filters":
          opts.onNavigate("/todo/filters");
          return;
        default:
          return;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      // No binding here uses Alt/Option — holding it is always either a
      // typed accented character or an OS/browser shortcut, never this
      // table's business.
      if (event.altKey) {
        return;
      }
      const typing = isTypingTarget(event.target);

      // A sequence's second key, or a non-matching key that cancels it —
      // issue #228's own "cleared on timeout or a non-matching key."
      if (pending !== null) {
        const prefix = pending.prefix;
        clearPending();
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          return;
        }
        const sequence = `${prefix} ${event.key.toLowerCase()}`;
        const binding = TODO_KEY_BINDINGS.find((candidate) => candidate.keys.includes(sequence));
        if (binding !== undefined && (!typing || binding.allowInField === true)) {
          event.preventDefault();
          fire(binding);
        }
        return;
      }

      // A sequence's first key — starts the short-lived pending state
      // rather than firing anything itself.
      const bareKey = event.key.toLowerCase();
      if (
        !typing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        SEQUENCE_PREFIXES.has(bareKey)
      ) {
        pending = { prefix: bareKey, timeout: setTimeout(clearPending, SEQUENCE_TIMEOUT_MS) };
        return;
      }

      const chord = chordFor(event);
      const binding = TODO_KEY_BINDINGS.find((candidate) => candidate.keys.includes(chord));
      if (binding === undefined) {
        return;
      }
      if (typing && binding.allowInField !== true) {
        // One exception, and only for the arrow keys: the "Add task"
        // composer is itself a stop in the row-navigation cycle
        // (`rowNavTargets`, todo-keymap.ts), so suppressing these two
        // bindings there unconditionally trapped focus inside it — in
        // both directions. An arrow already at the edge it points at
        // leaves the field and continues the cycle; anywhere else in the
        // text it keeps native caret movement
        // (`canLeaveAddTaskField` carries the full reasoning).
        //
        // Gated on the arrow chords, NOT on `binding.id` alone: `j`/`k`
        // share these bindings' `keys` and are ordinary characters, so
        // they must always type into the composer and never navigate.
        const escapeDirection =
          chord === "arrowdown" && binding.id === "focus-next-row"
            ? "next"
            : chord === "arrowup" && binding.id === "focus-previous-row"
              ? "previous"
              : null;
        if (escapeDirection === null || !canLeaveAddTaskField(event.target, escapeDirection)) {
          return;
        }
      }
      // `focus-next-row`/`focus-previous-row` are the only bindings whose
      // own keys (ArrowDown/ArrowUp/j/k) an open Radix overlay might
      // already be using for its own purpose — `TaskSchedulePopover`'s
      // day-picker grid, `TaskCommandMenu`'s own item navigation — and
      // neither is a text field `isTypingTarget` above would catch. Every
      // other binding here is either `task-focused` (already a no-op
      // once focus leaves a row for a portalled overlay, since
      // `focusedTaskId()` finds no `[data-task-id]` ancestor there) or
      // doesn't touch focus at all, so this check is scoped to just these
      // two rather than added as a blanket rule for every binding
      // (`isInsideOverlay`, todo-keymap.ts, has the full reasoning).
      if (
        (binding.id === "focus-next-row" || binding.id === "focus-previous-row") &&
        isInsideOverlay(event.target)
      ) {
        return;
      }
      event.preventDefault();
      fire(binding);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      clearPending();
    };
  }, []);
}
