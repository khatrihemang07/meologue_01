/**
 * Today (issue #169) — a second, co-equal view over the same Tasks Inbox
 * lists (ADR 0049), built entirely on `@meologue/core`'s `today()` and
 * `compareForToday`: this component never decides the union rule or the
 * sort chain itself, only how to lay out what `today()` already decided —
 * "the web layer renders what core decides" (169-brief.md's own words).
 *
 * Two sections. **Overdue** is always flat and always chronological — no
 * grouping control reaches it, ever (see the section below for why that's
 * not an oversight). **Due today** carries the grouping control
 * (`group-today-tasks.ts`) and the bulk of what a reader interacts with,
 * since Overdue's own remedy is a single Reschedule action, not per-Task
 * fiddling.
 */
import type { Task } from "@meologue/core";
import { today } from "@meologue/core";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { DatePickerSheet, localDayKey } from "@/components/date-picker-sheet";
import { type TaskDetailActions, TaskRow } from "@/components/todo/task-row";
import { Button } from "@/components/ui/button";
import { groupTodayTasks, type TodayGrouping } from "@/lib/group-today-tasks";

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
  /** Rescheduling only ever calls this — see the Overdue section's own comment on why Reschedule touches `date` and never `deadline`. */
  onSetDate: (id: string, date: string | null) => void;
  /**
   * Moves one overdue Task to tomorrow (TaskStore.postpone's own doc
   * comment) — the Overdue section's own "Postpone to tomorrow" button
   * below calls this once per overdue Task, mirroring the existing bulk
   * Reschedule button's identical `for (const task of overdue)` shape.
   * Works on any overdue Task, not only a recurring one (postpone's own
   * mechanics have nothing recurrence-specific about them), but issue
   * #170 is what asks for it to be reachable here at all: "postponing an
   * overdue recurring task moves it to tomorrow."
   */
  onPostpone: (id: string) => void;
}

export function TodayView({
  tasks,
  detailActions,
  onComplete,
  onCompleteForever,
  onRequestDelete,
  onOpenSchedule,
  onSetDate,
  onPostpone,
}: TodayViewProps) {
  const [grouping, setGrouping] = useState<TodayGrouping>("none");
  const [reschedulingOverdue, setReschedulingOverdue] = useState(false);

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
    <div className="flex flex-col gap-4">
      {overdue.length > 0 && (
        <section>
          <header className="flex items-center justify-between px-3 py-2">
            <h2 className="font-medium text-sm">Overdue ({overdue.length})</h2>
            <div className="flex gap-2">
              {/*
                A quick, one-tap nudge beside the arbitrary-date Reschedule
                picker — "postponing an overdue recurring task moves it to
                tomorrow" (issue #170) doesn't need a calendar opened for
                a destination that's always the same day. Real
                `TaskStore.postpone`, not `onSetDate(task.id, tomorrow)`
                computed by hand here: that store method already knows how
                to preserve a timed Task's own time-of-day across the move
                (its own doc comment), which this component would
                otherwise have to re-derive per Task.
              */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  for (const task of overdue) {
                    onPostpone(task.id);
                  }
                }}
              >
                Postpone to tomorrow
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setReschedulingOverdue(true)}
              >
                Reschedule
              </Button>
            </div>
          </header>
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
        </section>
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
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {/*
        A single bulk Reschedule (Todoist's own Overdue affordance), not a
        per-Task button — the section as a whole has one remedy, "move
        these forward," and a picker per row would just be this same
        action taken once per Task instead of once for the section.
        Reschedules only ever `onSetDate`, never `onSetDeadline`: a
        Deadline is the hard cutoff a Task must still be *done* by
        (CONTEXT.md's Deadline entry) — moving it because a reader hasn't
        gotten to the Task yet would quietly relax the one field that
        isn't supposed to move for that reason. A Task overdue purely by a
        passed Deadline, with no `date` at all, gets one from this action
        the same as any other — that's what actually clears it from
        Overdue.
      */}
      <DatePickerSheet
        open={reschedulingOverdue}
        onOpenChange={setReschedulingOverdue}
        onConfirm={(day) => {
          for (const task of overdue) {
            onSetDate(task.id, day);
          }
        }}
      />
    </div>
  );
}
