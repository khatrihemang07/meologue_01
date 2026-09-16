/**
 * Todoist's own dedicated Time dialog (issue #249's own disclosed
 * follow-up — that ticket relocated the "Add a time" toggle into
 * `task-schedule-popover.tsx` itself but explicitly left "Todoist's own
 * dedicated Time dialog... a separate follow-up, not part of this
 * ticket"). Captured structure (`meologue-reference/todoist/live-audit-dom/
 * flow3-SCHED-todoist.json`'s `SCHED-11`, `pass2-2026-09-11.md` §7):
 * `role="dialog" aria-label="Select start and end time"`, 306×216, radius
 * 10px, background `rgb(40,40,40)`, box-shadow `0 2px 8px rgba(0,0,0,
 * .16)` — no border was recorded (unlike the scheduler popover and Repeat
 * menu, both of which carry one), so none is drawn here.
 *
 * Two of Todoist's three recorded fields are deliberately not built:
 * **Duration** was removed from meologue outright (issue #179 — "a field
 * with nowhere to be") and is itself Pro-gated on the Free account this
 * was captured against, so there is no meologue concept to surface here
 * even setting Todoist's own paywall aside. **Time zone** has no
 * equivalent on a meologue `Task` at all — every time is floating
 * (CONTEXT.md's Date glossary entry: "9am means 9am wherever the Device
 * reading it happens to be, not 9am in some fixed timezone"), so there is
 * no per-Task value a Time-zone control could edit; building one would be
 * decoration with nothing behind it.
 *
 * **Start time** reuses the exact `<input type="time">` the former
 * inline "Add a time" control (relocated here, not reinvented) already
 * used, so a Task's stored `HH:MM` string never changes shape — only
 * *where* it's edited moves. Its accessible name changes from that
 * control's "Time" to Todoist's own captured "Start time"
 * (`live-audit-dom/flow3-SCHED-todoist.json`'s `SCHED-11.todoist.fields[0]
 * .ariaLabel`).
 *
 * **The "Add a time" checkbox is kept verbatim, not invented anew.**
 * SCHED-11's capture never recorded how Todoist itself removes an
 * already-set time from inside this dialog (a GAP, not `divergent`/
 * `matched`) — this ticket's own instruction for that case is to keep the
 * inline field's existing way of clearing a time, which was exactly this
 * checkbox. Unchecking it and saving is what commits `null`.
 *
 * **Save commits through the identical `onSave` callback the inline
 * control's `onSetTime` always was** — `task-schedule-popover.tsx` wraps
 * its own `onSetTime` (`handleTimeSave`, issue #326 below) rather than
 * passing it straight through, so this dialog still only ever changes
 * *where* that call is triggered from, never what it means for
 * `Task.date`'s time-of-day; the wrapping is the caller's own business of
 * also closing the scheduler on Save, not a change to what gets stored.
 * Cancel (and Escape, and an outside click — Radix's own ordinary `Dialog`
 * behaviour, left alone) discard whatever this dialog's own local draft
 * became; the next open re-seeds from the Task's real `time` prop rather
 * than remembering an unconfirmed edit (the identical reasoning
 * task-schedule-popover.tsx's own header comment already gives for its
 * sibling `typed` state).
 *
 * **Save/Cancel/Escape/an outside click do not all leave the scheduler in
 * the same state, though every one of them closes this dialog the same
 * way (issue #326).** Cancel and an outside click return to the scheduler
 * — `task-schedule-popover.tsx`'s own guard on `PopoverContent`
 * (`classifyOutsideInteraction`) is what makes that hold live, not
 * anything in this file. That guard classifies by *where an interaction's
 * real DOM target lands* (inside this dialog's own `data-testid="time-
 * dialog"` or not), never by whether this dialog's `open` state still
 * reads `true` — an earlier version tried the state/ref route and lost a
 * real dismiss-ordering race to it; that comment's own header explains why,
 * in enough detail that nobody should reach for it again. Escape and Save
 * both close the scheduler too, but neither does it by way of that guard
 * failing to catch a stray dismiss: Escape's own `onEscape` call below is
 * explicit, and so is the caller's `handleTimeSave` wrapper around `onSave`
 * — see each one's own comment. This file itself stays exactly as ignorant
 * of the distinction as its own "not know anything about its host" line
 * below already says: every close path here still just calls
 * `onOpenChange(false)`, identically.
 *
 * `modal={false}`, and no `Overlay`: the capture recorded no backdrop
 * element, and Todoist's own note is that this "stacks below/beside the
 * scheduler card rather than replacing it" — a modal `Dialog` would
 * aria-hide the scheduler popover behind it, which is the opposite of
 * that. The scheduler popover itself (`task-schedule-popover.tsx`) still
 * has to be told to ignore this dialog's own focus/pointer activity —
 * Radix's `DismissableLayer` otherwise reads the dialog's own autofocus
 * (moving focus to a portalled node the popover's `Content` doesn't
 * contain) as focus leaving the popover and closes it, the same two-
 * `FocusScope`-fight shape issue #255 already named for a Radix menu
 * opening a Radix popover. That guard lives on the caller's
 * `PopoverContent`, not here — this file only needs to exist as an
 * ordinary Radix `Dialog`, not know anything about its host — but it does
 * need this dialog's own `data-testid="time-dialog"` (below) to stay put,
 * since that's the hook the caller's guard classifies against.
 *
 * **SCHED-11's own follow-up (pass2-2026-09-11.md §7):** "One `Escape`
 * closes the Repeat/Time layer and the scheduler beneath it
 * simultaneously" — captured live, not this file's own guess. Radix's
 * default `Escape` handling already closes this dialog alone (the
 * `onOpenChange(false)` every dismiss path here already goes through);
 * `onEscapeKeyDown` below additionally calls `onEscape`, the caller's own
 * hook for closing the scheduler popover too. Deliberately not
 * `event.preventDefault()`-ed: this dialog is still meant to close itself
 * on `Escape` exactly as before, only now with the popover closing
 * alongside it, and no commit either way — `Escape` reaches this handler
 * instead of Save, so `onSave` never fires and the draft is discarded the
 * same as Cancel.
 */
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";

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
  /** SCHED-11's own follow-up (this file's own header comment) — fired on `Escape` alongside this dialog's own default close, so the caller can close the scheduler popover it opened from too. Never fired by Save/Cancel/an outside click. Cancel and an outside click return to the scheduler, same as before this prop existed; Save closes it too, through `onSave` above rather than through this prop — see that prop's own comment (issue #326 is what made this distinction load-bearing: all three used to *look* alike only because nothing yet told them apart). */
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
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-testid="time-dialog"
          // See this file's own header comment (SCHED-11's follow-up,
          // pass2-2026-09-11.md §7) — not preventDefault()-ed, so Radix's
          // own default `Escape` handling (close this dialog) still runs
          // alongside it.
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
          <DialogPrimitive.Title className="sr-only">
            Select start and end time
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Set the Task's start time, or remove it.
          </DialogPrimitive.Description>

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
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
