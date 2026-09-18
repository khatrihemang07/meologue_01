import type { Task } from "@meologue/core";
import { today } from "@meologue/core";
import { CheckCircle2 } from "lucide-react";
import { useCallback, useState } from "react";
import { OverdueSectionSummary } from "@/components/todo/overdue-section-summary";
import { type TaskDetailActions, TaskRow } from "@/components/todo/task-row";
import { useSwipeActions } from "@/hooks/use-swipe-actions";
import { groupTodayTasks, type TodayGrouping } from "@/lib/group-today-tasks";
import { localDayKey } from "@/lib/local-day-key";
import { OPEN_SCHEDULE_EVENT } from "@/lib/todo-keymap";

export interface TodayViewProps {
  /** Every active Task (TaskStore.list()'s result) — today() does its own filtering; this component never pre-narrows it. */
  tasks: Task[];
  /** Passed straight through to every row this view renders — see `TaskDetailActions`'s own doc comment (task-row.tsx). */
  detailActions: TaskDetailActions;
  /** `dateString` rides along so todo-page.tsx's own `handleComplete` can decide between `completeTask` and `advanceRecurringTask` — this component has no TaskStore access of its own to decide with. */
  onComplete: (id: string, content: string, dateString: string | null) => void;
  /** Shift+Click on a recurring Task's checkbox, or its touch-reachable button (task-row.tsx's own doc comments) — "Complete and archive recurring task," ending the series. */
  onCompleteForever: (id: string, content: string) => void;
  onRequestDelete: (id: string) => void;
  onOpenSchedule: (id: string) => void;
  /** Rescheduling only ever calls this — see overdue-reschedule-action.tsx's own comment on why Reschedule touches `date` and never `deadline`. */
  onSetDate: (id: string, date: string | null) => void;
}

export function TodayView({
  tasks,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onSetDate,
}: TodayViewProps) {
  const [grouping, setGrouping] = useState<TodayGrouping>("none");

  // Issue #303: swiping a row left opens its own `TaskSchedulePopover` —
  // reusing `use-swipe-actions.ts`'s shared recogniser (task-tree.tsx's own
  // identical wiring has the fuller reasoning for why this is reuse, not a
  // second recogniser). Attached once, to the outer wrapper below, rather
  // than once per section: Overdue and Due-today render as separate `<ul>`s
  // — and Due-today's own grouping can render several more, one per bucket
  // — with no ancestor of their own narrower than that wrapper, so this is
  // the one container guaranteed to sit above all of them regardless of
  // grouping. Called unconditionally, before the `isEmpty` early return
  // below, the same rule every other Hook call in this component already
  // follows.
  const openScheduleForSwipe = useCallback((target: HTMLElement) => {
    const taskId = target.dataset.taskId;
    if (taskId !== undefined) {
      // The identical fan-in the `T` keyboard shortcut already uses
      // (todo-keymap.ts's own `OPEN_SCHEDULE_EVENT` doc comment) — this
      // view has no direct reference to the swiped row's own `scheduleOpen`
      // state (owned by task-row.tsx, several props away).
      document.dispatchEvent(new CustomEvent(OPEN_SCHEDULE_EVENT, { detail: { taskId } }));
    }
  }, []);
  const swipeRowsRef = useSwipeActions({ onOpen: openScheduleForSwipe });

  // localDayKey(new Date()) rather than new Date().toISOString(): Today's
  // own boundary has to be the Device's local calendar day, not a UTC one
  // — the same floating-time discipline Task.date's own doc comment
  // requires of every caller, reused here (date-picker-sheet.tsx's own
  // exported helper) rather than re-derived a third time in this file.
  const { overdue, dueToday } = today(tasks, localDayKey(new Date()));
  const isEmpty = overdue.length === 0 && dueToday.length === 0;

  if (isEmpty) {
    return (
      // The empty state reads as an achievement, not a blank (this
      // ticket's own acceptance criterion) — "All caught up" plus a
      // sentence that says what actually happened (nothing due, nothing
      // overdue) rather than a bare icon, because a reader landing here
      // with an empty Inbox too would otherwise see two panels that both
      // say nothing, and only one of them is supposed to mean "you did
      // it."
      <div className="flex flex-col items-center gap-2 px-3 py-12 text-center">
        <CheckCircle2 aria-hidden="true" className="size-8 text-muted-foreground" />
        <p className="font-medium text-sm">All caught up</p>
        <p className="max-w-xs text-muted-foreground text-sm">
          Nothing is due today, and nothing is overdue. A Task lands here the moment its Date or
          Deadline arrives.
        </p>
      </div>
    );
  }

  return (
    <div ref={swipeRowsRef} className="flex flex-col gap-4">
      {overdue.length > 0 && (
        // `open`, `className="group"`: issue #337 gave this section
        // Todoist's own expand/collapse chevron, which needs a real
        // `<details>` to reflect — the identical structure and "open by
        // default" reasoning UpcomingView's own Overdue section already
        // uses (that file's own comment on why open-by-default is right).
        // `<section>`, non-collapsible, was this file's original shape
        // before #337; Todoist's own reference capture
        // (a03-todoist-today.json) has a collapse control on Today too.
        <details open className="group">
          <OverdueSectionSummary overdue={overdue} onSetDate={onSetDate} />
          {/*
            Always chronological, even though `todo-page.tsx`'s Inbox
            supports manual drag-to-reorder — this ticket's own acceptance
            criterion ("overdue is its own section ... always ordered
            chronologically even under manual sort") and task-views.ts's
            own guarantee that `overdue` never leaves compareForToday's
            order. No drag handlers are passed to TaskRow here (its own
            doc comment on `onHandlePointerDown` explains why omitting all
            four removes the grip handle rather than rendering an inert
            one) — a handle that could be dragged would imply an order a
            reader could set by hand, and there is no such order here to
            set.
          */}
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

      {dueToday.length > 0 && (
        <section>
          <header className="flex items-center justify-between px-3 py-2">
            <h2 className="font-medium text-sm">Due today ({dueToday.length})</h2>
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              Group by
              <select
                value={grouping}
                onChange={(event) => setGrouping(event.target.value as TodayGrouping)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-foreground text-xs"
              >
                <option value="none">None</option>
                <option value="priority">Priority</option>
              </select>
            </label>
          </header>
          {/*
            groupTodayTasks partitions `dueToday` — already in
            compareForToday's order — into buckets; it never re-sorts
            within one (group-today-tasks.ts's own doc comment, and its
            own regression test). No drag handlers here either, for the
            identical reason the Overdue section above has none: Today's
            order is computed, not chosen.
          */}
          {groupTodayTasks(dueToday, grouping).map((group) => (
            <div key={group.label || "ungrouped"}>
              {group.label !== "" && (
                <h3 className="px-3 py-1 text-muted-foreground text-xs">{group.label}</h3>
              )}
              <ul className="flex flex-col">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    detailActions={detailActions}
                    commentCount={detailActions.commentCountFor(task.id)}
                    onComplete={() => onComplete(task.id, task.content, task.dateString)}
                    onCompleteForever={() => onCompleteForever(task.id, task.content)}
                    onRequestDelete={() => onRequestDelete(task.id)}
                    onOpenSchedule={() => onOpenSchedule(task.id)}
                    suppressDateBadge
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
