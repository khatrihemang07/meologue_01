## What to build

A prefactor. Nothing visible changes — this makes the next ticket possible.

Todoist's scheduler is an **anchored popover positioned directly under the Date control**
(250×525, 10px radius). meologue already has a faithful replica of that card, but it is reachable
only from inside a bottom sheet, behind a "Pick a date" button — two layers Todoist does not have.
Before the popover can be anchored under each Date control, two things have to change about the
component itself:

1. **It must accept a controlled open state.** It already holds that state internally; it just
   never exposes it. The next ticket has three separate entry points that must open the *same*
   instance, which is impossible while the state is private.
2. **It must own the time-of-day control.** The "Add a time" toggle currently lives in the bottom
   sheet's Date section. Once Date leaves that sheet, the toggle has to go with it — otherwise a
   reader would set a date in one surface and its time in another.

Point 2 is the risk, and the reason this is its own ticket. The popover documents an explicit
"only ever picks a day" invariant, and several tests and comments rely on it. Teaching it about
time-of-day breaks that invariant deliberately, so it should land alone, fully tested, before any
entry point is rewired.

Todoist's own dedicated Time dialog has since been captured (`role="dialog"`, 306×216, Start time /
Duration — Pro-gated / Time zone "Floating time" / Save·Cancel). Building that is a **separate
follow-up**, not part of this ticket: relocating the existing toggle is the honest first step.

## Acceptance criteria

- [ ] The scheduler popover accepts an optional controlled open state, and callers that pass
      nothing behave exactly as they do today
- [ ] The "Add a time" toggle and its time input render inside the popover, below the calendar
- [ ] Setting a time still preserves the chosen day, and changing the day preserves an
      already-chosen time
- [ ] Clearing the date clears the time with it
- [ ] The component's day-only invariant is updated in its own documentation rather than silently
      contradicted
- [ ] No visible change to how the scheduler is reached — it is still opened from the bottom sheet
      at this point
- [ ] Existing scheduler tests pass, with new coverage for the time behaviour

## Blocked by

None — can start immediately.
