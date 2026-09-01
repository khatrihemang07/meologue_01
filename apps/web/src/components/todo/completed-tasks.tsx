import type { Task } from "@meologue/core";
import { Undo2 } from "lucide-react";

export interface CompletedTasksProps {
  tasks: Task[];
  onUncomplete: (id: string) => void;
}

/**
 * A completed Task's permanent home (this ticket's own acceptance
 * criterion: "the completed Task can be found and restored afterwards,"
 * not only within the toast's lifetime — `todo-page.tsx`'s own completion
 * toast fires the identical `onUncomplete`, this is just the other,
 * durable door to it). A native `<details>`/`<summary>` rather than a
 * second route or a component-state toggle: Todo's own route budget for
 * this ticket is `/todo` and `/todo/inbox` (App.tsx), and completed Tasks
 * are a secondary, occasional thing to check, not a view a reader
 * navigates to the way Inbox itself is — a disclosure widget is the
 * smallest honest affordance for "collapsed by default, open on request,"
 * and it costs nothing to keep working once #169 or a later ticket gives
 * Todo an actual Completed view of its own.
 *
 * Renders nothing at all when there is nothing completed yet, rather than
 * an empty, always-visible "Completed" disclosure with nothing inside it —
 * the same "don't show a section with nothing in it" restraint the empty
 * Inbox state (`todo-page.tsx`) takes the opposite way for the opposite
 * reason: Inbox is the primary view and always deserves a real state, a
 * secondary section with nothing in it yet is better left absent.
 */
export function CompletedTasks({ tasks, onUncomplete }: CompletedTasksProps) {
  if (tasks.length === 0) {
    return null;
  }

  return (
    <details className="mt-4 rounded-lg border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground text-sm">
        Completed ({tasks.length})
      </summary>
      <ul className="flex flex-col border-t border-border">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex items-center gap-2 border-border border-b px-3 py-2 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm line-through">
              {task.content}
            </span>
            <button
              type="button"
              aria-label={`Restore "${task.content}"`}
              onClick={() => onUncomplete(task.id)}
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Undo2 aria-hidden="true" className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
