import type { Task } from "@meologue/core";
import { storedPriorityOf, uiPriorityOf } from "@meologue/core";
import { useState } from "react";
import { DatePickerSheet } from "@/components/date-picker-sheet";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { formatDay } from "@/lib/format-task-date";
import { priorityPickerColour } from "@/lib/task-priority-colors";

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
                  {/* The same colour swatch `task-command-menu.tsx`'s own
                      priority submenu already renders, from the identical
                      `priorityPickerColour` — Todoist colours its priority
                      options everywhere it offers them (red/orange/blue, P4
                      unfilled), and this picker was the one place in meologue
                      that rendered four identical text buttons. The tokens
                      existed (`--td-priority-picker-1..4`, ADR 0069); this
                      control simply never read them. */}
                  <span
                    aria-hidden="true"
                    className="size-3 shrink-0 rounded-full"
                    style={{ backgroundColor: priorityPickerColour(ui) }}
                  />
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
