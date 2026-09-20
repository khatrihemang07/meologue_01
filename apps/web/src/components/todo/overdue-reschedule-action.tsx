/**
 * The single bulk Reschedule action an Overdue section offers (Todoist's
 * own affordance) — issue #170's TodayView carried this first; issue #299
 * gave UpcomingView its own Overdue section and this same action, and this
 * file is the one implementation both call rather than two that could
 * drift. `DatePickerSheet` was already shared; what wasn't was the
 * "Reschedule" button plus the open/closed state plus the `onConfirm` loop
 * that calls `onSetDate` once per overdue Task — that whole path is what
 * lives here now.
 *
 * Reschedules only ever `onSetDate` — there is no `onSetDeadline` to call
 * even if it wanted to (issue #376 removed it): a Deadline was always the
 * hard cutoff a Task must still be *done* by (CONTEXT.md's Deadline
 * entry, kept for D12's own record even now nothing reads the field), and
 * moving one because a reader hadn't gotten to the Task yet would have
 * quietly relaxed the one field that wasn't supposed to move for that
 * reason. Issue #375 already stopped a passed Deadline putting an undated
 * Task in Overdue at all, so every Task this action ever sees carries a
 * real `date` for it to move.
 *
 * No `initialDate` passed to the underlying `DatePickerSheet` — a bulk
 * move across Tasks with different original dates has no single "current"
 * day to seed the grid with, the same reasoning TodayView's original
 * inline call already made.
 *
 * The Button's own `onClick` stops propagation before opening the sheet:
 * harmless inside TodayView's plain `<div>` header, but load-bearing
 * inside UpcomingView's `<summary>` one — a native `<summary>` toggles its
 * `<details>` on any click that bubbles up to it, this button included,
 * so without this the first tap would both open the date picker and
 * collapse the section underneath it.
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
import type { Task } from "@meologue/core";
import { useState } from "react";
import { DatePickerSheet } from "@/components/date-picker-sheet";
import { Button } from "@/components/ui/button";

export interface OverdueRescheduleActionProps {
  /** The overdue Tasks a confirmed pick applies to — `today()`'s own `overdue` bucket, unfiltered. */
  overdue: Task[];
  onSetDate: (id: string, date: string | null) => void;
}

export function OverdueRescheduleAction({ overdue, onSetDate }: OverdueRescheduleActionProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 rounded-[5px] border-transparent bg-transparent px-3 font-semibold dark:border-transparent dark:bg-transparent"
        style={{ color: "var(--td-overdue-reschedule)" }}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        Reschedule
      </Button>
      <DatePickerSheet
        open={open}
        onOpenChange={setOpen}
        onConfirm={(day) => {
          for (const task of overdue) {
            onSetDate(task.id, day);
          }
        }}
      />
    </>
  );
}
