# 0086: Todo's own views replace; only the Task detail and Search push

## Status

Accepted. Closes issue #353, the follow-up
[0079](0079-back-is-for-screens-not-for-state-within-one.md) named explicitly and left undone —
that ADR's own Consequences section, "Todo is left non-compliant, on purpose," names the two
navigations this ADR fixes by name: `todo-nav.tsx`/`todo-sidebar.tsx`'s plain (pushing) `NavLink`s,
and `todo-page.tsx`'s `closeTaskDetail`. Builds on 0079's rule without amending it, and is aware of
[0049](0049-todo-is-the-first-destination-with-internal-navigation.md) and
[0076](0076-todos-navigation-is-what-the-shells-existing-pane-renders.md) the same way 0079 already
was: both establish that Todo carries navigation of its own; neither says anything about whether
that navigation should push.

## Context

0079's rule is "a history entry is earned by a navigation a reader would name as 'going somewhere
else' ... not by a navigation that keeps a reader inside the Destination they were already looking
at." It answered that question for Digest's date-stepping and named, but did not resolve, the
identical question for Todo — deliberately, because resolving it meant reasoning through
`todo-page.tsx`'s own history-state contract (`location.state.from`, `stepTaskDetail`'s existing
`replace`, and `closeTaskDetail`'s own comment on why it used a real `navigate` rather than
`navigate(-1)`) on its own terms, not as a drive-by on an ADR about Digest.

Todo is a harder case than Digest because it is not one screen stepping through one steppable
value — it is several distinct views (Inbox, Today, Upcoming, a Project, a Filter, Labels,
Activity, Browse), a modal (the Task detail), and a door to a different concern entirely (Search),
all reachable from inside the same Destination. 0079's own test — "does the reader think of
themselves as still looking at the same screen" — has to be applied once per navigation, not once
for Todo as a whole, and the answers are not all the same.

## Decision

**Moving between Todo's own views is interior state and replaces. Opening the Task detail and
reaching Search are departures and push. This is not a smaller version of 0079's rule; it is 0079's
rule applied to Todo's actual shape, where two of its navigations turn out to sit on the departure
side of the line and the rest do not.**

### Interior — replace

- **Every row `todo-nav.tsx`'s bottom bar and `todo-sidebar.tsx`'s `CountRow`/`ProjectRow` render**
  (Inbox, Today, Upcoming, Browse, each Project). Two co-equal ways into the same Tasks (0049's own
  framing) — a reader who taps Inbox, then Today, then a Project is still looking at Todo, just a
  different slice of it, exactly Digest's "different day of it" with a different axis.
- **Filter create (`filter-view.tsx`'s `handleSave`) and filter delete (its `ConfirmDialog`'s
  `onConfirm`), and the delete-Project redirect (`todo-page.tsx`'s `onDeleteProject`).** These earn
  `replace` for a second, independent reason on top of 0079's: the address left behind is not
  merely interior state a reader might reasonably return to, it is *dead* — `/todo/filters/new` once
  a Filter exists at `/todo/filters/:id`, or a Project's own screen once that Project no longer
  exists. A push here does not just violate 0079, it leaves Back pointed at something that no
  longer resolves to anything.
- **Quick-find's "open Project" (`todo-page.tsx`, `TaskQuickFind`'s `onOpenProject`).** A Project's
  own screen is the same destination `ProjectRow` links to; a reader who reaches it through
  Quick-find rather than the sidebar is still just looking at that Project, and the two doors have
  to agree on whether reaching it earns a history entry — 0079's rule is about the navigation
  itself, not which control triggered it.

### Departure — push

- **`openTaskDetail`.** 0079 named this exactly: "the Task detail is the deliberate exception: a
  modal is something you dismiss, so opening one still earns a history entry." A reader opening a
  Task is doing something categorically different from switching views — they are layering a
  focused, dismissable surface on top of whatever they were looking at, and Back's job for a modal
  is to dismiss it, not to have never been pushed at all. `stepTaskDetail` (moving to the next/
  previous Task while the modal is already open) stays `replace`, unchanged — stepping is the
  Digest-date case again, now nested one level inside the one push that opened the modal in the
  first place.
- **`openFullSearch` and the header Search `<Link>`.** Search is not one of Todo's own views the
  way Inbox or a Project is — it is a different concern (searching, rather than browsing a fixed
  list) that happens to be reachable from inside Todo, the same relationship a Session has to the
  Conversation it was opened from. `todo-page.test.tsx`'s "reaching Search from Today and going back
  returns to Today, not the root" is the test that locks this in, and it is unchanged by this ADR —
  it was already correct.

### `closeTaskDetail` adopts `goBack()`'s shape

`closeTaskDetail` used to be a plain `navigate(backgroundPath(backgroundView))` — a push, closing
the modal by growing the stack rather than shrinking it, which is what 0079 flagged. Because
`openTaskDetail` is a real push, closing is the same shape `digest-reader-page.tsx`'s and
`sessions-page.tsx`'s own `goBack()` already share: `navigate(-1)` when there is a real entry to pop
(the ordinary case — it lands exactly back on whatever was open before, background view, scroll
position and all, without this function ever computing `backgroundPath` at all), and a `replace`
onto `backgroundPath(backgroundView)` when `location.key === "default"` — a reader who reached this
Task's address directly (a bookmark, a shared link, a reload) has no in-app entry behind them, and
`navigate(-1)` would either no-op (leaving the dialog open, doing nothing) or pop somewhere outside
this app entirely. This is the identical guard `goBack()` already carries for the identical reason;
`closeTaskDetail` had simply never been rewritten to use it, because 0079 named but did not do that
rewrite.

## Alternatives considered

- **Make `openTaskDetail` (and therefore closing) `replace` too, so every Todo navigation follows
  the same rule uniformly.** Rejected: 0079 already carved out the Task detail as a deliberate
  exception, for a reason that still holds — a modal is dismissed, not walked out of, and a reader
  who opened five Tasks in a row from an activity log or search result would reasonably expect Back
  to peel them off one at a time, the same way any stacked dialog does elsewhere in this app. This
  would also break `todo-page.test.tsx`'s locked-in Search test, since Search is opened from
  wherever `backgroundView` currently is and a `replace`-only Task detail would have nothing
  Search-shaped left in the URL to record what that was.
- **Have `closeTaskDetail` always `navigate(backgroundPath(backgroundView), { replace: true })`,
  regardless of history, and drop the `location.key` check entirely.** Simpler — one line, no
  branch — and was considered specifically to avoid adding a second `goBack`-shaped function to the
  codebase. Rejected: since `openTaskDetail` pushes, a reader who opens and closes several Tasks in
  a row would grow the stack by one dead entry per cycle (push the Task, `replace` back onto the
  same background — leaving the *previous* background entry behind, not popping it), reintroducing
  exactly the "walks back through everything visited" failure 0079 exists to prevent, just one level
  removed from where 0079 first found it.
- **Have `closeTaskDetail` always `navigate(-1)`, with no `location.key` guard.** Rejected for the
  direct-link/reload case this ADR's own acceptance criteria names: with nothing behind the current
  entry, `navigate(-1)` is a no-op in a browser history stack — the URL doesn't change, the dialog
  doesn't close, and Back reads as broken rather than as "leaves Todo." The guard is what makes
  closing work identically whether or not there happens to be a real entry underneath.

## Consequences

Every Todo navigation now falls cleanly into one of the two categories this ADR names, and a future
destination added to Todo (a new flat view, a new modal) should ask which one it is rather than
defaulting to whatever `NavLink`/`navigate` does out of the box — `NavLink` pushes unless told
otherwise, which is exactly the gap 0079 found here in the first place.

**Two navigations are left pushing, on purpose, as a known gap rather than an oversight — the
identical honesty 0079 itself used for Todo as a whole.** `todo-sidebar.tsx`'s own "My Projects"
heading link (a plain `NavLink`, not `CountRow`) and Browse hub's own rows (`browse-view.tsx`,
plain `<Link>`s) reach `/todo/projects` and `/todo/filters`/`/todo/activity`/`/todo/projects`
respectively — every one of them a view this ADR calls interior elsewhere — but neither was in
issue #353's own scope (`todo-nav.tsx`'s rows and `todo-sidebar.tsx`'s `CountRow`/`ProjectRow`
specifically), and touching either risked reopening components another change was mid-flight on. A
reader who reaches Projects through the sidebar's heading, or any of Browse's rows, rather than a
`CountRow` or the bottom bar, still grows the history stack by one. Fixing this is real follow-up
work this ADR names but does not do, for the same reason 0079 named Todo's gap without fixing it:
naming it here is what keeps a future reader from reading these two as this ADR's oversight rather
than its own explicit boundary.
