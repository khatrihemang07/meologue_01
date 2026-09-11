## What to build

Task rows should render the colours and states measured from Todoist. Four divergences, all
confirmed by driving both applications side by side at the same viewport and reading computed
values — not inferred from code.

**1. Today and Tomorrow are the wrong colour.** Both currently render in the same "upcoming" purple
`rgb(169,112,255)`. Todoist renders **Today green `rgb(37,184,76)`** and **Tomorrow orange
`rgb(255,154,20)`** — three distinct colours, not one. Tomorrow cannot currently be styled
separately at all, because the date-tone logic folds "one day out" into the same tone as the rest
of the week. That needs a tone of its own.

Keep the existing purple for dates two to six days out — it is independently measured and correct.
A previously-recorded row claiming the Today colour reused that purple was an explicit guess, and
this measurement falsifies it.

**2. The Today view prints a redundant "Today" badge** on every row. Todoist omits the date control
from the DOM entirely in that view — every task there is due today, so the badge says nothing.

**3. Completed rows don't look completed.** Todoist renders the title `rgb(128,128,128)` with a
strikethrough and keeps the date visible in `rgb(204,204,204)`. meologue renders the title in
`rgb(204,204,204)`, shows no date at all, and applies no strikethrough — because strikethrough is
gated behind a Settings option whose default is off, so it effectively never appears.

**4. The checkbox ring is a fixed width.** Todoist thickens it to **2px at P1**, against 1px
elsewhere. The ring *colour* is already correct; only the width is flattened.

## Acceptance criteria

- [ ] A task due today renders its date in `rgb(37,184,76)`
- [ ] A task due tomorrow renders its date in `rgb(255,154,20)`
- [ ] Dates two to six days out still render the existing purple, unchanged
- [ ] The Today view renders no date control for tasks due today
- [ ] A completed row renders its title in `rgb(128,128,128)` with a strikethrough, regardless of
      the Settings completed-style option
- [ ] A completed row still shows its date, in `rgb(204,204,204)`
- [ ] A P1 row's checkbox ring is 2px; other priorities stay 1px
- [ ] Verified by driving the app and reading computed values, not by test assertions alone
- [ ] Affected parity ledger rows restatused with the measured evidence

## Blocked by

None — can start immediately.
