import type { Task } from "@meologue/core";
import { uiPriorityOf } from "@meologue/core";
import { CalendarClock, GripVertical, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { formatDay, formatTaskDate } from "@/lib/format-task-date";
import { cn } from "@/lib/utils";

export interface TaskRowProps {
  task: Task;
  onComplete: () => void;
  onRequestDelete: () => void;
  /**
   * Opens the schedule picker (issue #169's `TaskScheduleSheet`) for this
   * Task — every one of Date/Deadline/Duration/Priority is reachable from
   * here, in both Inbox and Today, since both render this same row. See
   * this ticket's own brief: "pickers, not text parsing," and this is the
   * one door onto them a reader always has, regardless of which view
   * they're looking at a Task from.
   */
  onOpenSchedule: () => void;
  /** Whether this row is the drop target of an in-progress drag — draws the "the dragged row lands here" line. Meaningless, and always `false`, on a row with no drag handlers (see below). */
  isDropTarget?: boolean;
  /**
   * All four omitted together, never some subset, is what removes the grip
   * handle entirely rather than rendering an inert one (issue #169's own
   * Today view is this option's first caller: Today's order is computed
   * from the sort chain in task-views.ts, not chosen by dragging, and a
   * handle a reader could grab that silently did nothing would be a worse
   * affordance than no handle at all — the same reasoning
   * `add-task-form.tsx`'s own header gives for not building UI ahead of a
   * feature that parses it). Inbox (`todo-page.tsx`) passes all four,
   * unchanged from issue #168.
   */
  onHandlePointerDown?: (event: PointerEvent<HTMLSpanElement>) => void;
  onHandlePointerMove?: (event: PointerEvent<HTMLSpanElement>) => void;
  onHandlePointerUp?: (event: PointerEvent<HTMLSpanElement>) => void;
  onHandlePointerCancel?: (event: PointerEvent<HTMLSpanElement>) => void;
}

/**
 * One active Task, in Inbox or in Today (issue #169 — both views render
 * this same row rather than each growing its own) — a checkbox
 * (completing, ADR 0047's own "completing is not a delete" distinction
 * from an Entry's), the Task's `content`, a compact schedule summary when
 * it has one, a drag handle, a Schedule button opening `TaskScheduleSheet`
 * (issue #169's pickers), and a Delete button behind the shared
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
  onOpenSchedule,
  isDropTarget = false,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandlePointerCancel,
}: TaskRowProps) {
  const hasSchedule = task.date !== null || task.deadline !== null || task.priority !== 1;
  const draggable =
    onHandlePointerDown !== undefined &&
    onHandlePointerMove !== undefined &&
    onHandlePointerUp !== undefined &&
    onHandlePointerCancel !== undefined;
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
      {draggable && (
        <span
          aria-hidden="true"
          data-testid="task-drag-handle"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerCancel}
          // `touch-action: none` is what makes a touch drag possible at all
          // — without it Chromium's own scroll gesture recogniser claims
          // the gesture before a second pointermove ever reaches this
          // handler, exactly as `pane-divider.tsx`'s own comment on its
          // handle explains. Scoped to the handle rather than the row (or
          // the list) is what keeps the rest of Inbox scrollable with a
          // finger — the opposite of `use-swipe-actions.ts`'s bubble,
          // which stays `pan-y` everywhere so the thread itself keeps
          // scrolling under a swipe.
          className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </span>
      )}
      <input
        type="checkbox"
        checked={false}
        onChange={onComplete}
        aria-label={task.content}
        className="shrink-0 accent-current"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{task.content}</span>
        {/* A compact schedule summary, present only once there's something
            to summarise (issue #169) — Date, then Deadline, then Priority
            (never "no priority", the same restraint the sort chain itself
            applies: a level that means "nothing chosen" doesn't deserve a
            badge). `formatTaskDate`/`formatDay` (lib/format-task-date.ts)
            are the same functions `TaskScheduleSheet` reads a Task's
            current value through, so this row can never show a date in
            words that disagree with what the picker itself would say. */}
        {hasSchedule && (
          <span className="flex flex-wrap gap-x-2 text-muted-foreground text-xs">
            {task.date !== null && <span>{formatTaskDate(task.date)}</span>}
            {task.deadline !== null && <span>Due {formatDay(task.deadline)}</span>}
            {task.priority !== 1 && <span>P{uiPriorityOf(task.priority)}</span>}
          </span>
        )}
      </span>
      {/*
        Both this Schedule button and the Delete button below follow the
        same visibility rule, revealed on hover or focus on a pointer
        device, always present on a touch one — the same split
        `entry-actions.tsx` already makes for an Entry row's Edit/Delete.
        Todo has no `EntryActionsSheet`-equivalent sheet a touch reader
        could reach either through instead, so base state is visible and
        `(hover: hover)` is what *takes each away* at rest — the inverse of
        the Entry row's rule, arriving at the same result on both device
        classes.

        `opacity`, not `display`, on the hover-capable path, for
        `entry-actions.tsx`'s own reason: each button stays in the layout
        and in the tab order, so `focus-visible` can bring it back for a
        keyboard user who never hovers anything.
      */}
      <button
        type="button"
        aria-label={`Schedule "${task.content}"`}
        onClick={onOpenSchedule}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
        )}
      >
        <CalendarClock aria-hidden="true" className="size-4" />
      </button>
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
