/**
 * The Deadline and Priority pickers (issue #169's own acceptance
 * criterion: "settable from pickers, without needing any text parsing" —
 * #170's quick-add grammar is a second door onto these same fields, not a
 * prerequisite for this one, and this file has to stand on its own
 * without it). Duration was a third such field until issue #179 removed
 * it from the product entirely — it existed to serve calendar and
 * time-blocking views this app never built, so it had nowhere to be; this
 * sheet no longer has a section for it.
 *
 * **Date left this sheet entirely in issue #253**, whose own anchored
 * `TaskSchedulePopover` (that file's own header comment: Todoist's own
 * scheduler, an anchored popover, not this sheet's shape) is now reached
 * directly from a row's hover Date button, the detail view's own Date
 * attribute, the More-actions "Date…" item and the `T` shortcut — three
 * entry points sharing one per-row instance, none of them this sheet. That
 * ticket's own report is where the fuller reasoning lives; what's left
 * here is only the title this sheet still shares with the sheet issue
 * #227 first built ("Schedule "<task>""), unchanged — Todoist's own
 * scheduler card is Date-specific, but this app's shared sheet name
 * predates that split and nothing asked for a second rename.
 *
 * Deadline still reuses `DatePickerSheet` (and, through it,
 * `components/ui/calendar.tsx`) exactly as it always has — a nested
 * `Sheet` opening on top of this one (Radix's `Dialog.Root` tolerates more
 * than one open at a time) rather than closing this sheet first and
 * reopening it once the pick resolves: the alternative needs to remember
 * which field was mid-edit and replay that open across an extra render,
 * for a saving — one sheet visible instead of two stacked — this repo
 * already spends elsewhere (`EntryActionsSheet`'s own delete confirmation
 * layers a dialog over its sheet the identical way). Deadline is
 * Pro-gated on the account this ticket's own reference corpus was
 * captured against, so neither its picker nor its row rendering is
 * observable (`docs/reference/todoist/parity-ledger.md` `SCHED-13`/
 * `DATE-08`, both `blocked`) — nothing here should, or does, guess at
 * what that picker would look like.
 *
 * Every picker here commits immediately, with no separate "Save" — the
 * nested Deadline date pick and the four priority buttons both call their
 * setter the moment they're used. `DatePickerSheet`'s own tap-then-confirm
 * two-step exists to protect a scroll position in History a mis-tap would
 * cost dearly to undo (its own header comment); nothing here has an
 * equivalent cost — either field can be set right back with another tap,
 * so an extra confirmation step would only slow down the common case for
 * a mistake that costs nothing to correct.
 */
import type { Task } from "@meologue/core";
import { storedPriorityOf, uiPriorityOf } from "@meologue/core";
import { useState } from "react";
import { DatePickerSheet } from "@/components/date-picker-sheet";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatDay } from "@/lib/format-task-date";

export interface TaskScheduleSheetProps {
  /** The Task being scheduled, looked up fresh by id on every render of the caller — never a snapshot taken when the sheet opened, so a picker's own effect is visible the moment the next render lands. */
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetDeadline: (id: string, deadline: string | null) => void;
  onSetPriority: (id: string, priority: number) => void;
}

export function TaskScheduleSheet({
  task,
  open,
  onOpenChange,
  onSetDeadline,
  onSetPriority,
}: TaskScheduleSheetProps) {
  const [pickingDeadline, setPickingDeadline] = useState(false);

  const uiPriority = uiPriorityOf(task.priority);

  return (
    // A Fragment, not the Deadline `<DatePickerSheet>` placed inside
    // `<Sheet>...</Sheet>` below: Radix's `Dialog.Root` clones a handful of
    // recognised child types (`Trigger`, `Close`) through context, and
    // there's no reason to hand it a second, entire independent
    // `Dialog.Root` tree as a child it has no defined behaviour for —
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
