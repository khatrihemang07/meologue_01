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
 * (meologue-reference/todoist/scheduler-and-priority.md §9, DATE-05 in the
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
 *
 * **Overdue (issue #299).** Ahead of the day sections, an `Overdue`
 * disclosure renders `today()`'s own `overdue` bucket — the identical
 * Tasks TodayView's own Overdue section shows, called with the same
 * `now` this component already derives, not a second "is this overdue"
 * check written here. That is Todoist's own shape: an overdue Task shows
 * in both Today and Upcoming, not Today only — the reverse of what this
 * view used to do (task-views.ts's own header comment on `upcoming()`
 * has the fuller history of the reversed rule). `<details>/<summary>`
 * rather than a `<button aria-expanded aria-controls>` pair, the same
 * native-disclosure call task-detail-view.tsx's Comments section already
 * makes for equal behaviour.
 *
 * The `<summary>` itself — bare `Overdue`, the bulk `Reschedule` button,
 * and the expand/collapse chevron — is `overdue-section-summary.tsx`, one
 * implementation TodayView's own Overdue section renders too (that file's
 * own header comment has the full reasoning, including the Todoist DOM
 * capture the three-node order is read off). `className="group"` on the
 * `<details>` below is what lets that shared summary's own chevron read
 * this element's `open` state via Tailwind's `group-open` variant — the
 * summary component itself doesn't render the `<details>` around it, so
 * every caller has to supply the class. No `Postpone to tomorrow`: that
 * was Today's own further divergence from Todoist and issue #337 removed
 * it there too, so there's no longer anything to not-propagate. No drag
 * handlers here, for the identical reason the day sections above have
 * none.
 */
import type { Task } from "@meologue/core";
import { today, upcoming, upcomingDayHeading } from "@meologue/core";
import { CalendarClock } from "lucide-react";
import { useCallback } from "react";
import { OverdueSectionSummary } from "@/components/todo/overdue-section-summary";
import { type TaskDetailActions, TaskRow } from "@/components/todo/task-row";
import { useSwipeActions } from "@/hooks/use-swipe-actions";
import { localDayKey } from "@/lib/local-day-key";
import { OPEN_SCHEDULE_EVENT } from "@/lib/todo-keymap";

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
  /** The Overdue section's own bulk Reschedule button calls this — see `overdue-reschedule-action.tsx`'s own doc comment on why `onSetDate` and never `onSetDeadline`. */
  onSetDate: (id: string, date: string | null) => void;
}

export function UpcomingView({
  tasks,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onSetDate,
}: UpcomingViewProps) {
  // Issue #303: reuses `use-swipe-actions.ts`'s shared recogniser —
  // today-view.tsx's own identical wiring has the fuller reasoning, both
  // for why this is reuse rather than a second recogniser and for why the
  // container ref goes on the outer wrapper below rather than on any one
  // day-section's own `<ul>`.
  const openScheduleForSwipe = useCallback((target: HTMLElement) => {
    const taskId = target.dataset.taskId;
    if (taskId !== undefined) {
      document.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId } }));
    }
  }, []);
  const swipeRowsRef = useSwipeActions({ onOpen: openScheduleForSwipe });

  // localDayKey(new Date()), not new Date().toISOString(): the identical
  // "Today's boundary is the Device's local calendar day" discipline
  // today-view.tsx's own comment requires, reused rather than re-derived.
  const now = localDayKey(new Date());
  const days = upcoming(tasks, now);
  // Same `now` as `upcoming()` just above, passed to the identical
  // `today()` TodayView calls — one derivation of "overdue," reused, not
  // a second one written here that could drift from TodayView's.
  const { overdue } = today(tasks, now);

  if (days.length === 0 && overdue.length === 0) {
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
    <div ref={swipeRowsRef} className="flex flex-col gap-4">
      {overdue.length > 0 && (
        // `open` by default: TodayView's own Overdue section is always
        // visible, never collapsed, and this is the same Tasks shown a
        // second time here — starting collapsed would hide the one thing
        // this section exists to surface. `className="group"`:
        // overdue-section-summary.tsx's own chevron reads this element's
        // `open` state through it.
        <details open className="group">
          <OverdueSectionSummary overdue={overdue} onSetDate={onSetDate} />
          <ul className="flex flex-col">
            {overdue.map((task) => (
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
        </details>
      )}

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
