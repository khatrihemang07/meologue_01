## What to build

**A reported defect.** Opening a Task's Date should show Todoist's scheduler, anchored directly
under the control that was clicked.

Todoist's scheduler is an anchored popover — 250×525, 10px radius — positioned under the Date
button. meologue already has a faithful replica of that card, measured byte-for-byte. The problem
is everything around it: the Date control opens a **bottom sheet** titled `Schedule "<task>"`
holding Date, Deadline and Priority together, and the good popover sits two layers deep inside it,
behind a "Pick a date" button. So the card measures perfectly while the way you reach it is wrong —
which is exactly how this row stayed marked healthy while the feature didn't match.

Three entry points must open the **same** anchored instance: the row's hover Date button, the
More-actions "Date…" item, and the `T` shortcut. The codebase already solved this identical fan-in
problem for the row's command menu (a document-level event keyed on the task), and that precedent
should be reused rather than inventing a second mechanism.

Once nothing needs it, the bottom sheet loses its Date section and keeps only Deadline and
Priority. **Deadline keeps its existing picker** — it is Pro-gated in Todoist, so there is no
reference to match it against and nothing should be guessed at.

**A trap this project has already paid for once:** the popover library's "render as my child"
mechanism clones the trigger and attaches a ref to it, so the trigger must be a real
ref-forwarding element. The shared button component is not one — a plain button carrying the same
styles is required. When this was broken before, *every test still passed*, because the test
environment lays nothing out and so never noticed the popover anchoring at the viewport origin.
The same applies to the detail view's attribute pill and row.

Expect roughly twenty tests to change.

## Acceptance criteria

- [ ] Clicking Date on a task row opens the scheduler anchored under that control — no bottom sheet
- [ ] The same is true from the detail view's Date attribute
- [ ] The More-actions "Date…" item and the `T` shortcut open that same anchored popover
- [ ] The popover measures 250×525 with a 10px radius, matching the captured reference
- [ ] Anchoring is verified in a real browser, not only in tests — the failure mode here is
      invisible to the test environment
- [ ] The bottom sheet no longer offers Date, and still offers Deadline and Priority
- [ ] Deadline's own picker is unchanged
- [ ] Setting a date, clearing it, and setting a recurrence all still work from every entry point
- [ ] Both the Todo and Composer surfaces are rewired; neither passes props that no longer exist
- [ ] Affected parity ledger rows restatused, including the one whose evidence recorded the card's
      geometry while never recording that reaching it cost two extra layers

## Blocked by

- #249 — the popover must accept a controlled open state and own the time toggle before it can be
  anchored from three separate entry points.
