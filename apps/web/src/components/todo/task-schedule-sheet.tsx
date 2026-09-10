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
 * Deadline still reuses `DatePickerSheet` (and, through it,
 * `components/ui/calendar.tsx`) exactly as it always has — a nested
 * `Sheet` opening on top of this one (Radix's `Dialog.Root` tolerates more
 * than one open at a time) rather than closing this sheet first and
 * reopening it once the pick resolves: the alternative needs to remember
 * which field was mid-edit and replay that open across an extra render,
 * for a saving — one sheet visible instead of two stacked — this repo
 * already spends elsewhere (`EntryActionsSheet`'s own delete confirmation
 * layers a dialog over its sheet the identical way). Date no longer
 * shares that mechanism (see this file's own note on `TaskSchedulePopover`
 * below) — the two fields' pickers simply look different now, which is
 * fine: Date and Deadline are independent fields (a Task may carry
 * either, both, or neither — CONTEXT.md's Deadline entry), never assumed
 * to share a picker just because they once happened to.
 *
 * Every picker here commits immediately, with no separate "Save" — the
 * scheduler popover's own quick options and calendar, the nested Deadline
 * date pick, and the four priority buttons all call their setter the
 * moment they're used. `DatePickerSheet`'s own tap-then-confirm two-step
 * exists to protect a scroll position in History a mis-tap would cost
 * dearly to undo (its own header comment); nothing here has an equivalent
 * cost — every one of these four fields can be set right back with
 * another tap, so an extra confirmation step would only slow down the
 * common case for a mistake that costs nothing to correct.
 *
 * **Date's own picker (issue #227) is `TaskSchedulePopover`, not a second
 * `DatePickerSheet`** — that file's own header comment has the full
 * reasoning (an anchored popover replicating Todoist's own scheduler,
 * geometry and all). Deadline keeps the original `DatePickerSheet`
 * untouched: it is Pro-gated on the account this ticket's own reference
 * corpus was captured against, so neither its picker nor its row
 * rendering is observable (`docs/reference/todoist/parity-ledger.md`
 * `SCHED-13`/`DATE-08`, both `blocked`) — nothing here should, or does,
 * guess at what that picker would look like.
 */
import type { Task } from "@meologue/core";
import { hasTime, storedPriorityOf, uiPriorityOf } from "@meologue/core";
import { useState } from "react";
import { DatePickerSheet } from "@/components/date-picker-sheet";
import { TaskSchedulePopover } from "@/components/todo/task-schedule-popover";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatDay } from "@/lib/format-task-date";
import { cn } from "@/lib/utils";

export interface TaskScheduleSheetProps {
  /** The Task being scheduled, looked up fresh by id on every render of the caller — never a snapshot taken when the sheet opened, so a picker's own effect is visible the moment the next render lands. */
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetDate: (id: string, date: string | null) => void;
  onSetDeadline: (id: string, deadline: string | null) => void;
  onSetPriority: (id: string, priority: number) => void;
  /** Sets or clears the Task's Recurrence (issue #227's own "editable Recurrence" ask) — `TaskStore.setDateString`'s own doc comment has the full reasoning, including why `date` is recomputed by the store rather than trusted from a caller. */
  onSetDateString: (id: string, dateString: string | null, now: string) => void;
  /** Day-keys carrying at least one active Task, mapped to how many — threaded straight through to `TaskSchedulePopover`'s identical prop (its own doc comment: SCHED-09's calendar dot and SCHED-04's preview subline share this one source). Optional, defaulting to "nothing is busy," for callers (and this file's own tests) with no reason to compute it. */
  datesWithTasks?: ReadonlyMap<string, number>;
}

// A default time for the "Add a time" toggle below — 9am reads as "start
// of a normal working day" without this file trying to guess a reader's
// actual schedule; the picker exists specifically so nobody has to type a
// more precise one, and the `<input type="time">` right below it is where
// that precision comes from instead.
const DEFAULT_TIME = "09:00";

// A stable empty default for `datesWithTasks` — a fresh `new Map()` on
// every render with no `datesWithTasks` prop supplied would otherwise be a
// harmless-looking new object identity each time, the kind of thing that
// only bites once something downstream (a `useMemo`/`useEffect`
// dependency) starts keying off it.
const EMPTY_DATES_WITH_TASKS: ReadonlyMap<string, number> = new Map();

export function TaskScheduleSheet({
  task,
  open,
  onOpenChange,
  onSetDate,
  onSetDeadline,
  onSetPriority,
  onSetDateString,
  datesWithTasks = EMPTY_DATES_WITH_TASKS,
}: TaskScheduleSheetProps) {
  const [pickingDeadline, setPickingDeadline] = useState(false);

  const dateDay = task.date === null ? null : task.date.slice(0, 10);
  const dateTime = task.date !== null && hasTime(task.date) ? task.date.slice(11, 16) : null;
  const uiPriority = uiPriorityOf(task.priority);

  function setDay(day: string | null) {
    // Preserves an existing time-of-day across a day change (picking a new
    // date shouldn't silently drop a time the reader already chose) —
    // `null` (the scheduler popover's own "No Date") skips straight past
    // that: there is no day left for a time-of-day to attach to.
    if (day === null) {
      onSetDate(task.id, null);
      return;
    }
    onSetDate(task.id, dateTime === null ? day : `${day}T${dateTime}`);
  }

  return (
    // A Fragment, not the Deadline `<DatePickerSheet>` placed inside
    // `<Sheet>...</Sheet>` below: Radix's `Dialog.Root` clones a handful of
    // recognised child types (`Trigger`, `Close`) through context, and
    // there's no reason to hand it a second, entire independent
    // `Dialog.Root` tree as a child it has no defined behaviour for —
    // `DatePickerSheet` already manages its own open state through its own
    // `open`/`onOpenChange` props and needs nothing from this component's
    // own `Sheet` beyond sitting in the same render tree. `TaskSchedulePopover`
    // above has no such conflict — it's a `Popover.Root`, not a second
    // `Dialog.Root` — so it sits directly inside `<SheetContent>` instead.
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="gap-4">
          <SheetTitle className="truncate px-1 pt-1 text-sm font-medium">
            Schedule "{task.content}"
          </SheetTitle>

          <section className="flex flex-col gap-2 px-1">
            <h3 className="text-muted-foreground text-xs">Date</h3>
            <div className="flex flex-wrap gap-2">
              <TaskSchedulePopover
                dateDay={dateDay}
                dateString={task.dateString}
                datesWithTasks={datesWithTasks}
                onPickDay={(day) => {
                  setDay(day);
                  // A plain date (or "No Date") ends any Recurrence the
                  // Task already had — TaskSchedulePopover's own header
                  // comment names this a deliberate, disclosed design
                  // decision (Todoist's own capture never exercised
                  // picking a plain date on an already-recurring Task):
                  // the typed input is the one door onto a Recurrence
                  // (SCHED-04/05), so a quick option or calendar click is
                  // read as "just this one day" rather than a second,
                  // silent way to leave a Recurrence in place while
                  // changing what `date` shows.
                  if (task.dateString !== null) {
                    onSetDateString(task.id, null, new Date().toISOString());
                  }
                }}
                // Ignores the popover's own resolved `day` — TaskStore.
                // setDateString recomputes `date` itself from `dateString`
                // (its own doc comment on why a caller-resolved date is
                // never trusted directly), so passing it through here
                // would be a value this sheet reads but never uses.
                onPickRecurrence={(dateString) =>
                  onSetDateString(task.id, dateString, new Date().toISOString())
                }
                trigger={
                  // A plain `<button>`, not `<Button>`, as `task-row-
                  // content.tsx`'s own `TaskCommandMenu` trigger already is
                  // — found the hard way, in a real browser, not by this
                  // file's own test suite: Radix's `asChild` clones this
                  // element and attaches a ref to it so the popover can
                  // measure the trigger's own position, and `Button`
                  // (ui/button.tsx) is a plain function component with no
                  // `forwardRef`, so that ref silently goes nowhere and the
                  // popover anchors at the viewport's origin instead of
                  // under the button — every test here passed regardless,
                  // because jsdom never lays anything out. `buttonVariants`
                  // keeps the identical visual style without needing the
                  // component itself.
                  <button
                    type="button"
                    className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                  >
                    {/* Deliberately plain `formatDay`, not issue #224's own
                        tone-aware `describeTaskDay` — this button is *setting*
                        a value, not reading one back: a picker naming exactly
                        which day is currently chosen ("Sep 5") is what a
                        reader mid-edit needs, where the row/detail view's own
                        relative wording ("Saturday") is for a reader who
                        isn't looking at a calendar right next to it. */}
                    {dateDay === null ? "Pick a date" : formatDay(dateDay)}
                  </button>
                }
              />
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
              `task.dateString` rendered verbatim, never re-derived through
              ../recurrence/'s engine — the identical string task-row.tsx
              shows, so this sheet can never disagree with the row it
              opened from. Issue #227 is what makes this line more than a
              read-out: the scheduler popover's own "Type a date" input
              (already seeded with this exact text on open — its own
              header comment) is where an existing Recurrence gets
              *changed*; "Clear repeat" here is the direct, always-visible
              way to remove one entirely, mirroring "Clear date"/"Clear
              deadline" alongside it rather than requiring a reader to
              delete the popover's own typed text down to nothing first.
            */}
            {task.dateString !== null && (
              <div className="flex items-center gap-2">
                <p className="text-muted-foreground text-sm">Repeats: {task.dateString}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onSetDateString(task.id, null, new Date().toISOString())}
                >
                  Clear repeat
                </Button>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2 px-1">
            {/* Date-only, deliberately no time toggle here — a Deadline is
              date-only by definition (CONTEXT.md's Deadline entry), and
              the store refuses a timed one outright (assertValidDeadline).
              Untouched by issue #227: this file's own header comment on
              why Deadline keeps its original `DatePickerSheet` rather than
              gaining a scheduler popover of its own. */}
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
        open={pickingDeadline}
        onOpenChange={setPickingDeadline}
        initialDate={task.deadline ?? undefined}
        onConfirm={(day) => onSetDeadline(task.id, day)}
      />
    </>
  );
}
