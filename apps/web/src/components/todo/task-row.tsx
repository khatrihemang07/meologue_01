import type { Task } from "@meologue/core";
import { GripVertical, Trash2 } from "lucide-react";
import type { DragEvent } from "react";
import { cn } from "@/lib/utils";

export interface TaskRowProps {
  task: Task;
  onComplete: () => void;
  onRequestDelete: () => void;
  /** Whether this row is the drop target of an in-progress drag — draws the "the dragged row lands here" line. */
  isDropTarget: boolean;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}

/**
 * One active Task in Inbox — a checkbox (completing, ADR 0047's own
 * "completing is not a delete" distinction from an Entry's), the Task's
 * `content`, a drag handle, and a Delete button behind the shared
 * `ConfirmDialog` (`todo-page.tsx` owns the one dialog instance, the same
 * "one instance for however many rows" rule `sessions-page.tsx`'s own
 * `SessionRow` follows).
 *
 * The checkbox mirrors `entry-prose.tsx`'s task-item styling
 * (`accent-current`, an `aria-label` carrying the Task's own words rather
 * than a generic "Checked"/"Unchecked") — the same control, reached from a
 * second Destination now that a Task has one of its own (ADR 0047's Todo
 * row and an Entry's checkbox are the same kind of thing since ADR 0048,
 * so they read the same on screen too.
 *
 * `draggable` sits on this `<li>` itself, using the browser's native HTML5
 * drag-and-drop rather than a pointer-event gesture recogniser (the swipe
 * pattern `use-swipe-actions.ts` uses for an Entry row): native DnD is the
 * smallest mechanism that already gives `dragover`/`drop` for free, and
 * `todo-inbox.tsx`'s own comment on `handleDrop` is where the *keyboard*
 * gap this leaves (issue #171's own criterion, not this ticket's) is named
 * rather than silently accepted.
 */
export function TaskRow({
  task,
  onComplete,
  onRequestDelete,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TaskRowProps) {
  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-task-id={task.id}
      className={cn(
        "flex items-center gap-2 rounded-lg border-t-2 border-t-transparent px-3 py-2.5 transition-colors hover:bg-muted",
        // A top border rather than a background swap for the drop
        // indicator: it reads as "the row lands between here and the row
        // above" without implying the hovered row itself is what's moving.
        isDropTarget && "border-t-primary",
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </span>
      <input
        type="checkbox"
        checked={false}
        onChange={onComplete}
        aria-label={task.content}
        className="shrink-0 accent-current"
      />
      <span className="min-w-0 flex-1 truncate text-sm">{task.content}</span>
      <button
        type="button"
        aria-label={`Delete "${task.content}"`}
        onClick={onRequestDelete}
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}
