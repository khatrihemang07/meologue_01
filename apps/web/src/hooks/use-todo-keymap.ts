import type { Task } from "@meologue/core";
import { useEffect, useRef } from "react";
import {
  chordFor,
  focusedTaskId,
  isTypingTarget,
  OPEN_COMMAND_MENU_EVENT,
  TODO_KEY_BINDINGS,
  type TodoKeyBinding,
} from "@/lib/todo-keymap";

export interface UseTodoKeymapOptions {
  /** Looks a Task up by id — `todo-page.tsx`'s own `tasks`/`completedTasks` two-list lookup (`openTask`'s own doc comment there gives the reason both lists matter), handed in rather than duplicated here. */
  resolveTask: (taskId: string) => Task | null;
  onOpenTaskDetail: (task: Task) => void;
  onOpenSchedule: (taskId: string) => void;
  onSetTaskDate: (taskId: string, date: string | null) => void;
  onSetTaskDeadline: (taskId: string, deadline: string | null) => void;
  onRequestDelete: (taskId: string) => void;
  onOpenQuickFind: () => void;
  onShowShortcuts: () => void;
  onNavigate: (path: string) => void;
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
        case "set-date":
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
