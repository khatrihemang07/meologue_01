/**
 * The single bulk Reschedule action an Overdue section offers (Todoist's
 * own affordance) — issue #170's TodayView carried this first; issue #299
 * gave UpcomingView its own Overdue section and this same action, and this
 * file is the one implementation both call rather than two that could
 * drift.
 *
 * Issue #435: the button is now the trigger of the identical
 * `TaskSchedulePopover` a Task's own Date button opens (`task-row-
 * content.tsx`'s own instance), not the old tap-then-Confirm
 * `DatePickerSheet` — Todoist treats the two as one component, and the
 * only difference here is the empty starting state: `dateDay`/`dateTime`/
 * `dateString` are all passed as `null` (this action has no single Task's
 * own values to seed the picker with — a bulk move across Tasks with
 * different existing dates has no single "current" one), and
 * `alwaysDated` (that popover's own doc comment) keeps the Time button and
 * the "No Date" quick option visible even though no day is picked yet,
 * since every Overdue Task this action ever sees already carries a real
 * date of its own for a bulk Time or a bulk clear to land on.
 *
 * Each of the picker's three commit doors funnels through a loop over
 * `overdue`, applying the identical thing `task-row-content.tsx`'s own
 * per-row wiring would apply to one Task, to all of them at once:
 *
 * - `onPickDay` (a quick option, a calendar click, or a typed plain date):
 *   moves each Task's own day while re-attaching that Task's own existing
 *   time-of-day (`withDay`, `@meologue/core`'s task-fields.ts — the same
 *   function `useTaskDateState`'s own `setScheduleDay` calls, issue #435's
 *   own code review asked for one door instead of two hand-copied
 *   `hasTime`/`.slice` reimplementations) — `onSetDate` alone never
 *   touches `dateString` (`TaskStore.setDate`'s own implementation
 *   confirms this), so a Task's Recurrence rides along untouched for
 *   free, the identical thing `task-row-content.tsx`'s own `onPickDay`
 *   wiring already relies on for a non-`null` day. `null` (the picker's
 *   own "No Date" quick option) clears both `date` and, for any Task that
 *   still carries one, `dateString` too — the same pairing that same call
 *   site's `day === null` branch already does, since a cleared date
 *   leaves no day left for a Recurrence to land on.
 * - `onSetTime`: sets or clears the time-of-day on each Task's own
 *   existing day via `withTime` (`task-fields.ts`'s own doc comment) —
 *   never `null` in practice — every Task this action ever sees carries a
 *   real `date`, this file's own next paragraph explains why.
 * - `onPickRecurrence`: sets the same phrase on every Task via
 *   `onSetDateString`, ignoring the popover's own resolved `day` argument
 *   — that argument is only a preview computed against "today" as a
 *   stand-in anchor (no single Task to anchor it to), while
 *   `TaskStore.setDateString` itself re-anchors against each Task's own
 *   `date` when it actually commits, the identical per-Task anchoring
 *   `task-row-content.tsx`'s own `onPickRecurrence` wiring already leans
 *   on.
 *
 * There is no `onSetDeadline` to call even if it wanted to (issue #376
 * removed it): a Deadline was always the hard cutoff a Task must still be
 * *done* by (CONTEXT.md's Deadline entry, kept for D12's own record even
 * now nothing reads the field), and moving one because a reader hadn't
 * gotten to the Task yet would have quietly relaxed the one field that
 * wasn't supposed to move for that reason. Issue #375 already stopped a
 * passed Deadline putting an undated Task in Overdue at all, so every Task
 * this action ever sees carries a real `date` for it to move.
 *
 * The trigger is a plain `<button>`, not `<Button>` (ui/button.tsx) —
 * `task-row-content.tsx`'s own Date button needed the identical
 * substitution for the identical reason (that file's own comment): Radix's
 * `asChild` clones this element and attaches a ref to it to measure where
 * to anchor the popover, and `Button` is a plain function component with
 * no `forwardRef`, so — as that file found the hard way, in a real
 * browser, not by either file's own test suite (jsdom never lays anything
 * out to notice) — that ref would silently go nowhere. `buttonVariants`
 * (the same `cva` recipe `Button` itself calls) reproduces its rendered
 * output on a real element instead.
 *
 * Its own `onClick` still stops propagation before the popover/sheet's own
 * click-to-open handling runs: harmless inside TodayView's plain `<div>`
 * header, but load-bearing inside UpcomingView's `<summary>` one — a
 * native `<summary>` toggles its `<details>` on any click that bubbles up
 * to it, this button included, so without this the first tap would both
 * open the picker and collapse the section underneath it. Radix composes
 * this handler with its own rather than replacing it, so both still run on
 * the same click — this only stops the click from reaching the ancestor
 * `<summary>`, not from reaching Radix's own trigger logic on this same
 * node.
 *
 * `LazyTaskSchedulePopover` (not the eager `TaskSchedulePopover` import)
 * for the identical reason `task-row-content.tsx` already needs it —
 * `lazy-task-schedule-popover.ts`'s own doc comment on the ~35 KB of
 * `date-fns`/Radix `Popover`/`Calendar` this keeps out of Today/Upcoming's
 * own eager bundle. It needs its own `<Suspense>` boundary here: this is a
 * second, independent instance of the lazy component, not a descendant of
 * any row's own boundary, and React suspends the moment it tries to render
 * this element at all — regardless of whether the popover is currently
 * open — the same reason that file's own fallback exists.
 *
 * The look (issue #337, Todoist web computed styles, dark theme) is
 * `variant="outline"` with its background, border colour, radius,
 * padding, height and weight all overridden rather than a bespoke
 * `buttonVariants` entry: every other `outline` button in the app keeps
 * its current look, and cva's own `className` merge (`cn()`, tailwind-
 * merge) resolves each override in place of the variant's default
 * without a second `variant` to maintain. `border-transparent`/
 * `dark:border-transparent` keep the `1px` border Todoist's own DOM
 * carries (`1px solid rgba(0,0,0,0)`) rather than removing it — an
 * invisible border still occupies its box, which a `border-0` button
 * sitting next to a bordered one would not. Text colour is a `style`
 * prop, not a Tailwind arbitrary-value class, matching every other
 * `--td-*` colour consumer in this app (`task-priority-colors.ts`,
 * `format-task-date.ts`): inline `style` also outranks the `outline`
 * variant's own `hover:text-foreground`, so the colour holds on hover —
 * untested by the app's own token but a byproduct of CSS specificity,
 * not a second guess about what Todoist's own hover state does (that
 * state was never measured; only idle was).
 */
import type { LocalDayKey, Task } from "@meologue/core";
import { withDay, withTime } from "@meologue/core";
import { Suspense, useState } from "react";
import { LazyTaskSchedulePopover } from "@/components/todo/lazy-task-schedule-popover";
import { buttonVariants } from "@/components/ui/button";
import { localDayKey } from "@/lib/local-day-key";
import { cn } from "@/lib/utils";

export interface OverdueRescheduleActionProps {
  /** The overdue Tasks a confirmed pick applies to — `today()`'s own `overdue` bucket, unfiltered. */
  overdue: Task[];
  onSetDate: (id: string, date: string | null) => void;
  /** Applies a picked Recurrence to every overdue Task — `TaskDetailActions.onSetDateString`'s own doc comment (task-row.tsx). */
  onSetDateString: (id: string, dateString: string | null, today: LocalDayKey) => void;
  /** The same busy-day map every Task's own picker reads — `TaskDetailActions.datesWithTasks`, threaded through unfiltered so this picker's own calendar marks real Tasks, not just `overdue`'s own. */
  datesWithTasks: ReadonlyMap<string, number>;
}

const TRIGGER_CLASS_NAME = cn(
  buttonVariants({ variant: "outline", size: "sm" }),
  "h-8 rounded-[5px] border-transparent bg-transparent px-3 font-semibold dark:border-transparent dark:bg-transparent",
);

export function OverdueRescheduleAction({
  overdue,
  onSetDate,
  onSetDateString,
  datesWithTasks,
}: OverdueRescheduleActionProps) {
  const [open, setOpen] = useState(false);

  function applyDay(day: string | null) {
    if (day === null) {
      for (const task of overdue) {
        onSetDate(task.id, null);
        if (task.dateString !== null) {
          onSetDateString(task.id, null, localDayKey(new Date()));
        }
      }
      return;
    }
    for (const task of overdue) {
      onSetDate(task.id, withDay(task.date, day));
    }
  }

  function applyTime(time: string | null) {
    for (const task of overdue) {
      // `withTime` returns `null` only when the Task itself has no `date`
      // to attach a time to — never reachable here (this file's own header
      // comment: every overdue Task carries a real `date`).
      onSetDate(task.id, withTime(task.date, time));
    }
  }

  function applyRecurrence(dateString: string) {
    const today = localDayKey(new Date());
    for (const task of overdue) {
      onSetDateString(task.id, dateString, today);
    }
  }

  return (
    <Suspense
      fallback={
        <button type="button" disabled className={TRIGGER_CLASS_NAME}>
          Reschedule
        </button>
      }
    >
      <LazyTaskSchedulePopover
        open={open}
        onOpenChange={setOpen}
        dateDay={null}
        dateTime={null}
        dateString={null}
        datesWithTasks={datesWithTasks}
        alwaysDated
        onSetTime={applyTime}
        onPickDay={applyDay}
        onPickRecurrence={applyRecurrence}
        trigger={
          <button
            type="button"
            className={TRIGGER_CLASS_NAME}
            style={{ color: "var(--td-overdue-reschedule)" }}
            onClick={(event) => event.stopPropagation()}
          >
            Reschedule
          </button>
        }
      />
    </Suspense>
  );
}
