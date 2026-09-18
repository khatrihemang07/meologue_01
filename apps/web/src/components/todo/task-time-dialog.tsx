import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";

// The former inline control's own default (task-schedule-popover.tsx's
// prior `DEFAULT_TIME`, relocated here with it) — 9am reads as "start of
// a normal working day" without guessing a reader's actual schedule.
const DEFAULT_TIME = "09:00";

export interface TaskTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `Task.date`'s time-of-day (`HH:MM`), or `null` when the Task is all-day. Re-seeds this dialog's local draft on every open — never read on later renders while already open, matching this file's own header comment. */
  time: string | null;
  /** Fired only on Save, with the drafted value (or `null` once "Add a time" is unchecked) — the exact shape `task-schedule-popover.tsx`'s own `onSetTime` prop already expects. That caller wraps it (`handleTimeSave`, issue #326) rather than passing `onSetTime` straight through, so Save also closes the scheduler popover it opened from — deliberately, on the caller's side; this file only ever asks for the value. */
  onSave: (time: string | null) => void;
  onEscape: () => void;
}

export function TaskTimeDialog({
  open,
  onOpenChange,
  time,
  onSave,
  onEscape,
}: TaskTimeDialogProps) {
  const [hasTime, setHasTime] = useState(time !== null);
  const [value, setValue] = useState(time ?? DEFAULT_TIME);
  const inputId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only on the open transition (Cancel/Escape/outside-click never commit, so the next open must reflect the Task's real `time`, not an abandoned draft) — not on every `time` prop change while already open, which would fight whatever the reader is currently typing.
  useEffect(() => {
    if (open) {
      setHasTime(time !== null);
      setValue(time ?? DEFAULT_TIME);
    }
  }, [open]);

  function handleSave() {
    onSave(hasTime ? value : null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPortal>
        <DialogContent
          open={open}
          data-testid="time-dialog"
          onEscapeKeyDown={onEscape}
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-[70] flex w-[306px] flex-col gap-3 p-3 text-sm outline-hidden"
          style={{
            minHeight: "216px",
            borderRadius: "10px",
            background: "rgb(40, 40, 40)",
            color: "rgb(255, 255, 255)",
            boxShadow: "rgba(0, 0, 0, 0.16) 0px 2px 8px 0px",
          }}
        >
          <DialogTitle className="sr-only">Select start and end time</DialogTitle>
          <DialogDescription className="sr-only">
            Set the Task's start time, or remove it.
          </DialogDescription>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hasTime}
              onChange={(event) => setHasTime(event.target.checked)}
            />
            Add a time
          </label>

          {hasTime && (
            <div className="flex flex-col gap-1">
              <label htmlFor={inputId} className="text-xs" style={{ color: "rgb(169, 169, 169)" }}>
                Start time
              </label>
              <input
                id={inputId}
                type="time"
                aria-label="Start time"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="w-fit rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              />
            </div>
          )}

          <div className="mt-auto flex justify-end gap-2">
            <Button type="button" size="sm" onClick={handleSave}>
              Save
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
