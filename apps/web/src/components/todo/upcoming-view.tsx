/**
 * Upcoming (issue #223's second half) — a third, co-equal view over the
 * same Tasks Inbox and Today list (ADR 0049), built entirely on
 * `@meologue/core`'s `upcoming()`/`upcomingDayHeading()`: this component
 * never decides which day a Task belongs to or how a day-section's own
 * heading reads, only how to lay out what core already decided — the
 * identical "the web layer renders what core decides" split
 * today-view.tsx's own header comment states for Today.
 *
 * One section per calendar day `upcoming()` returns a day for, each
 * headed by `upcomingDayHeading()`'s exact wording
 * (meologue-parity-docs/todoist/scheduler-and-priority.md §9, DATE-05 in the
 * parity ledger: "10 Sep ‧ Today ‧ Thursday," weekday-only past
 * tomorrow). No grouping control the way Today's own "Due today" section
 * has one (`group-today-tasks.ts`) — Upcoming's one and only grouping
 * *is* the day, which is the entire premise of the view, so there is
 * nothing left for a reader to re-group it by.
 *
 * No drag handlers on any row, mirroring Today's own Overdue/Due-today
 * sections (today-view.tsx's own comment on why): a day-section's order
 * is `compareForToday`'s chain, computed, not chosen, and a handle that
 * could be dragged would imply an order this view has no mechanism to
 * persist (there is no `dayOrder`-equivalent field for "this Task's
 * position within its Upcoming day").
 */
import type { Task } from "@meologue/core";
import { upcoming, upcomingDayHeading } from "@meologue/core";
import { CalendarClock } from "lucide-react";
import { type TaskDetailActions, TaskRow } from "@/components/todo/task-row";
import { localDayKey } from "@/lib/local-day-key";

export interface UpcomingViewProps {
  /** Every active Task (TaskStore.list()'s result) — upcoming() does its own filtering; this component never pre-narrows it, mirroring TodayView's identical `tasks` prop. */
  tasks: Task[];
  /** Passed straight through to every row this view renders — see `TaskDetailActions`'s own doc comment (task-row.tsx). */
  detailActions: TaskDetailActions;
  /** `dateString` rides along so todo-page.tsx's own `handleComplete` can decide between `completeTask` and `advanceRecurringTask` — this component has no TaskStore access of its own to decide with. */
  onComplete: (id: string, content: string, dateString: string | null) => void;
  /** Shift+Click on a recurring Task's checkbox, or its touch-reachable button — "Complete and archive recurring task," ending the series. */
  onCompleteForever: (id: string, content: string) => void;
  onRequestDelete: (id: string) => void;
  onOpenSchedule: (id: string) => void;
}

export function UpcomingView({
  tasks,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
}: UpcomingViewProps) {
  // localDayKey(new Date()), not new Date().toISOString(): the identical
  // "Today's boundary is the Device's local calendar day" discipline
  // today-view.tsx's own comment requires, reused rather than re-derived.
  const now = localDayKey(new Date());
  const days = upcoming(tasks, now);

  if (days.length === 0) {
    return (
      // Mirrors TodayView's own "All caught up" empty state shape (an
      // achievement/explanation pair, not a bare icon) — worded for what
      // is actually true here: nothing has a Date today or later, not
      // that every dated Task is done.
      <div className="flex flex-col items-center gap-2 px-3 py-12 text-center">
        <CalendarClock aria-hidden="true" className="size-8 text-muted-foreground" />
        <p className="font-medium text-sm">Nothing scheduled</p>
        <p className="max-w-xs text-muted-foreground text-sm">
          No Task carries a Date today or later. Give one a Date from Inbox or Today to see it here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {days.map((day) => (
        <section key={day.dayKey}>
          <header className="px-3 py-2">
            <h2 className="font-medium text-sm">{upcomingDayHeading(day.dayKey, now)}</h2>
          </header>
          <ul className="flex flex-col">
            {day.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                detailActions={detailActions}
                commentCount={detailActions.commentCountFor(task.id)}
                onComplete={() => onComplete(task.id, task.content, task.dateString)}
                onCompleteForever={() => onCompleteForever(task.id, task.content)}
                onRequestDelete={() => onRequestDelete(task.id)}
                onOpenSchedule={() => onOpenSchedule(task.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
