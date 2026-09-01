import type { Task } from "@meologue/core";
import { GripVertical, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { cn } from "@/lib/utils";

export interface TaskRowProps {
  task: Task;
  onComplete: () => void;
  onRequestDelete: () => void;
  /** Whether this row is the drop target of an in-progress drag — draws the "the dragged row lands here" line. */
  isDropTarget: boolean;
  onHandlePointerDown: (event: PointerEvent<HTMLSpanElement>) => void;
  onHandlePointerMove: (event: PointerEvent<HTMLSpanElement>) => void;
  onHandlePointerUp: (event: PointerEvent<HTMLSpanElement>) => void;
  onHandlePointerCancel: (event: PointerEvent<HTMLSpanElement>) => void;
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
 * The grip handle carries the pointer listeners, not this `<li>` — issue
 * #168 shipped this row with the browser's native HTML5 drag-and-drop
 * (`draggable` on the `<li>`), which does nothing on Android: WebView never
 * synthesises `dragstart` from touch input, so the grip handle sat on every
 * row as an affordance for a gesture that could not happen there. Pointer
 * Events replace it, following the same recogniser shape
 * `use-swipe-actions.ts` already uses for an Entry row's swipe — one
 * mechanism across mouse, touch and pen, rather than native DnD for a
 * mouse and a second, bespoke path for a finger. Scoping the listeners to
 * the handle rather than the whole row is deliberate, not incidental: a
 * pointerdown anywhere else on the row has to keep scrolling the list on
 * touch, which is the entire reason a grip handle exists as a separate
 * element instead of making the row itself draggable. The *keyboard* gap
 * this still leaves is issue #171's own criterion, not this ticket's.
 */
export function TaskRow({
  task,
  onComplete,
  onRequestDelete,
  isDropTarget,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandlePointerCancel,
}: TaskRowProps) {
  return (
    <li
      data-task-id={task.id}
      className={cn(
        "group flex items-center gap-2 rounded-lg border-t-2 border-t-transparent px-3 py-2.5 transition-colors hover:bg-muted",
        // A top border rather than a background swap for the drop
        // indicator: it reads as "the row lands between here and the row
        // above" without implying the hovered row itself is what's moving.
        isDropTarget && "border-t-primary",
      )}
    >
      <span
        aria-hidden="true"
        data-testid="task-drag-handle"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
        // `touch-action: none` is what makes a touch drag possible at all —
        // without it Chromium's own scroll gesture recogniser claims the
        // gesture before a second pointermove ever reaches this handler,
        // exactly as `pane-divider.tsx`'s own comment on its handle
        // explains. Scoped to the handle rather than the row (or the list)
        // is what keeps the rest of Inbox scrollable with a finger — the
        // opposite of `use-swipe-actions.ts`'s bubble, which stays
        // `pan-y` everywhere so the thread itself keeps scrolling under a
        // swipe.
        className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
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
      {/*
        Revealed on hover or focus on a pointer device, always present on a
        touch one — the same split `entry-actions.tsx` already makes for an
        Entry row's Edit/Delete, and made here for the same reason: a
        destructive control sitting permanently beside a checkbox is both
        visual noise on every row and a mis-tap away from destroying a Task.

        It diverges from that file in one way, deliberately. An Entry's
        hover actions are `hidden` outright outside `(hover: hover)` because
        a touch device reaches the identical actions through
        `EntryActionsSheet` instead. Todo has no such sheet yet, so hiding
        this button on touch would leave a phone with no way to delete a
        Task at all. Base state is therefore visible, and `(hover: hover)`
        is what *takes it away* at rest — the inverse of the Entry row's
        rule, arriving at the same result on both device classes.

        `opacity`, not `display`, on the hover-capable path, for
        `entry-actions.tsx`'s own reason: the button stays in the layout and
        in the tab order, so `focus-visible` can bring it back for a
        keyboard user who never hovers anything.
      */}
      <button
        type="button"
        aria-label={`Delete "${task.content}"`}
        onClick={onRequestDelete}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
        )}
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}
