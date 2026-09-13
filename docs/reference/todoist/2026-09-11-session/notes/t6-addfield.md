## What to build

Todoist's add-task affordance is a quiet **"+ Add task" row at the end of the list** — 14px,
`rgb(128,128,128)`, no border, no button. meologue's is a bordered input with an "Add" button
rendered **above** the list. Two gaps: position and visual weight. This ticket closes both.

**Position.** The add field renders once, before the view switch, so it appears above whichever
view is showing. Because Inbox, Today and a Project are mutually exclusive branches, moving that
one render below them puts it after the list in all three — no per-view duplication.

**Weight.** Restyle toward the muted, borderless row Todoist uses.

**Keep the elements as they are.** Todoist's real behaviour is a *static label* that expands into a
composer on click, with its own date, priority and project pickers. That is a UI pattern in its own
right — focus handling, escape-to-collapse, anchoring — and is **deliberately deferred** to its own
ticket. Folding it in here would mean the field and its button don't exist until after a click,
which breaks a range of existing tests and the end-to-end add-task flow for no parity gain that
position and weight don't already deliver.

So: the field stays always-mounted with its accessible name intact, and the Add button stays
rendered-but-disabled when empty rather than unmounting. That choice is what keeps the existing
tests and the e2e flow passing untouched.

## Acceptance criteria

- [ ] The add field renders **after** the task list in Inbox, Today and a Project view
- [ ] Views that deliberately have no add field (Projects, Search, Upcoming, Filters, Labels,
      Activity) still have none
- [ ] It renders as a quiet 14px row in the muted grey, with no border box
- [ ] The field is still always mounted and still carries its accessible name
- [ ] The Add button is still present and simply disabled while the field is empty
- [ ] Existing add-task unit and end-to-end tests pass without modification
- [ ] The deferred click-to-reveal composer is recorded in the parity ledger as a named,
      known gap rather than left to read as unnoticed

## Blocked by

None — can start immediately.
