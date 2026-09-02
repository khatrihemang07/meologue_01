/**
 * The one place Date, Deadline and Priority are all settable
 * (issue #169's own acceptance criterion: "settable from pickers, without
 * needing any text parsing" — #170's quick-add grammar is a second door
 * onto these same fields, not a prerequisite for this one, and this
 * file has to stand on its own without it). Duration was a fourth such
 * field until issue #179 removed it from the product entirely — it
 * existed to serve calendar and time-blocking views this app never built,
 * so it had nowhere to be; this sheet no longer has a section for it.
 *
 * Reuses `DatePickerSheet` (and, through it, `components/ui/calendar.tsx`)
 * for both the Date and the Deadline pick, rather than a second calendar
 * built for this file — the brief's own instruction. The two nested picks
 * below are two separate `<DatePickerSheet>` instances, not one shared
 * between the fields: Date and Deadline are independent (a Task may carry
 * either, both, or neither — CONTEXT.md's Deadline entry), and a single
 * shared sheet would need extra state just to remember which field it was
 * currently standing in for.
 *
 * A nested `Sheet` opening on top of this one (Radix's `Dialog.Root`
 * tolerates more than one open at a time) rather than closing this sheet
 * first and reopening it once the pick resolves: the alternative needs to
 * remember which field was mid-edit and replay that open across an extra
 * render, for a saving — one sheet visible instead of two stacked — this
 * repo already spends elsewhere (`EntryActionsSheet`'s own delete
 * confirmation layers a dialog over its sheet the identical way).
 *
 * Every picker here commits immediately, with no separate "Save" — Date's
 * "Today"/"Tomorrow" shortcuts, the nested date picks, and the four
 * priority buttons all call their setter the
 * moment they're used. `DatePickerSheet`'s own tap-then-confirm two-step
 * exists to protect a scroll position in History a mis-tap would cost
 * dearly to undo (its own header comment); nothing here has an equivalent
 * cost — every one of these four fields can be set right back with
 * another tap, so an extra confirmation step would only slow down the
 * common case for a mistake that costs nothing to correct.
 */
import type { Task } from "@meologue/core";
import { hasTime, storedPriorityOf, uiPriorityOf } from "@meologue/core";
import { addDays } from "date-fns";
import { useState } from "react";
import { DatePickerSheet, localDayKey } from "@/components/date-picker-sheet";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatDay } from "@/lib/format-task-date";

export interface TaskScheduleSheetProps {
  /** The Task being scheduled, looked up fresh by id on every render of the caller — never a snapshot taken when the sheet opened, so a picker's own effect is visible the moment the next render lands. */
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetDate: (id: string, date: string | null) => void;
  onSetDeadline: (id: string, deadline: string | null) => void;
  onSetPriority: (id: string, priority: number) => void;
}

// A default time for the "Add a time" toggle below — 9am reads as "start
// of a normal working day" without this file trying to guess a reader's
// actual schedule; the picker exists specifically so nobody has to type a
// more precise one, and the `<input type="time">` right below it is where
// that precision comes from instead.
const DEFAULT_TIME = "09:00";

export function TaskScheduleSheet({
  task,
  open,
  onOpenChange,
  onSetDate,
  onSetDeadline,
  onSetPriority,
}: TaskScheduleSheetProps) {
  const [pickingDate, setPickingDate] = useState(false);
  const [pickingDeadline, setPickingDeadline] = useState(false);

  const dateDay = task.date === null ? null : task.date.slice(0, 10);
  const dateTime = task.date !== null && hasTime(task.date) ? task.date.slice(11, 16) : null;
  const uiPriority = uiPriorityOf(task.priority);

  function setDay(day: string) {
    // Preserves an existing time-of-day across a day change (picking a new
    // date shouldn't silently drop a time the reader already chose), but
    // the "Today"/"Tomorrow" shortcuts below call onSetDate directly with
    // an all-day value instead of through here — a quick shortcut reads as
    // "move this to today," not "move this to today, keeping whatever time
    // happened to be set before."
    onSetDate(task.id, dateTime === null ? day : `${day}T${dateTime}`);
  }

  return (
    // A Fragment, not the two nested `<DatePickerSheet>`s placed inside
    // `<Sheet>...</Sheet>` below: Radix's `Dialog.Root` clones a handful of
    // recognised child types (`Trigger`, `Close`) through context, and
    // there's no reason to hand it two entire independent `Dialog.Root`
    // trees as children it has no defined behaviour for — each
    // `DatePickerSheet` already manages its own open state through its own
    // `open`/`onOpenChange` props and needs nothing from this component's
    // own `Sheet` beyond sitting in the same render tree.
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="gap-4">
          <SheetTitle className="truncate px-1 pt-1 text-sm font-medium">
            Schedule "{task.content}"
          </SheetTitle>

          <section className="flex flex-col gap-2 px-1">
            <h3 className="text-muted-foreground text-xs">Date</h3>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onSetDate(task.id, localDayKey(new Date()))}
              >
                Today
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onSetDate(task.id, localDayKey(addDays(new Date(), 1)))}
              >
                Tomorrow
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPickingDate(true)}
              >
                {dateDay === null ? "Pick a date" : formatDay(dateDay)}
              </Button>
              {dateDay !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onSetDate(task.id, null)}
                >
                  Clear date
                </Button>
              )}
            </div>
            {dateDay !== null && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dateTime !== null}
                  onChange={(event) => {
                    if (event.target.checked) {
                      onSetDate(task.id, `${dateDay}T${DEFAULT_TIME}`);
                    } else {
                      // Dropping the time makes this Task all-day again.
                      onSetDate(task.id, dateDay);
                    }
                  }}
                />
                Add a time
              </label>
            )}
            {dateTime !== null && (
              <input
                type="time"
                aria-label="Time"
                value={dateTime}
                onChange={(event) => onSetDate(task.id, `${dateDay}T${event.target.value}`)}
                className="w-fit rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            )}
            {/*
              Read-only, deliberately — this file's own header comment
              draws the line at "pickers, not text parsing," and a
              recurrence rule is text by definition (CONTEXT.md's
              Recurrence entry, issue #170): the add field
              (add-task-form.tsx) is where one is typed, parsed and
              demotable, and that's the one door onto creating or
              changing one. What belongs here is only "show the reader
              what they typed" — `task.dateString` rendered verbatim,
              never re-derived through ../recurrence/'s engine, so this
              sheet can never disagree with the row it opened from
              (task-row.tsx shows the identical string).
            */}
            {task.dateString !== null && (
              <p className="text-muted-foreground text-sm">Repeats: {task.dateString}</p>
            )}
          </section>

          <section className="flex flex-col gap-2 px-1">
            {/* Date-only, deliberately no time toggle here — a Deadline is
              date-only by definition (CONTEXT.md's Deadline entry), and
              the store refuses a timed one outright (assertValidDeadline).
              Reuses the identical `<DatePickerSheet>` component as the
              Date section above, just aimed at a different setter — this
              is the "one date UI, two callers" the brief's own instruction
              asks for. */}
            <h3 className="text-muted-foreground text-xs">Deadline</h3>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPickingDeadline(true)}
              >
                {task.deadline === null ? "Pick a deadline" : formatDay(task.deadline)}
              </Button>
              {task.deadline !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onSetDeadline(task.id, null)}
                >
                  Clear deadline
                </Button>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2 px-1 pb-1">
            <h3 className="text-muted-foreground text-xs">Priority</h3>
            <div className="flex gap-2">
              {[1, 2, 3, 4].map((ui) => (
                <Button
                  key={ui}
                  type="button"
                  size="sm"
                  variant={ui === uiPriority ? "default" : "outline"}
                  aria-pressed={ui === uiPriority}
                  onClick={() => onSetPriority(task.id, storedPriorityOf(ui))}
                >
                  {`P${ui}`}
                </Button>
              ))}
            </div>
          </section>
        </SheetContent>
      </Sheet>

      <DatePickerSheet
        open={pickingDate}
        onOpenChange={setPickingDate}
        initialDate={dateDay ?? undefined}
        onConfirm={setDay}
      />
      <DatePickerSheet
        open={pickingDeadline}
        onOpenChange={setPickingDeadline}
        initialDate={task.deadline ?? undefined}
        onConfirm={(day) => onSetDeadline(task.id, day)}
      />
    </>
  );
}
