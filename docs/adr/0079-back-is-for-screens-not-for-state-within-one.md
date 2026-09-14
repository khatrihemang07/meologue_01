# 0079: Back is for screens, not for state within one

## Status

Accepted. Builds on [0030](0030-the-shell-gets-a-root-screen.md), whose root screen is what Back
returns a reader to once they leave a Destination, and on [0025](0025-sessions-are-held-by-the-server.md),
whose "the URL is the only state" call for a Session this ADR's worked example leans on in the
identical way — the date stays in the URL; only whether stepping it earns a history entry changes.
Aware of, but does not amend, [0049](0049-todo-is-the-first-destination-with-internal-navigation.md)
and [0076](0076-todos-navigation-is-what-the-shells-existing-pane-renders.md): both establish that
Todo carries navigation of its own, scoped to its interior, and neither one said anything about
whether moving between Todo's own views should push a history entry. This ADR's rule bears
directly on that question — see *Todo is left non-compliant, on purpose* under Consequences — but
Todo's own navigation is not touched by this change.

No prior ADR decided the question this one answers; the position it retires
(`digest-reader-page.tsx:49-66`'s doc comment and `digest-reader-page.test.tsx:542`'s test name)
was never written down as a decision, only assumed and then encoded directly into a component
comment and a test. This ADR is the first place the general rule is stated.

## Context

Issue #72 gave the Digest reader prev/next controls that step from one day's Digest to its
neighbour, and built them as a `<Link to={`/digest/${period}/${date}`}>` rather than a `replace`
navigation, deliberately: `digest-reader-page.tsx`'s own comment on `DigestStepControl` called this
"load-bearing for this ticket's own acceptance criteria ('browser back walks the steps')" — the
idea being that a reader who stepped from Monday to Tuesday to Wednesday should be able to walk
back through Tuesday and Monday one Back press at a time before finally leaving the Digest archive.
`digest-reader-page.test.tsx:542` locked that reading in by name: "stepping is a real route change:
browser back from a step returns to the prior Digest, not out of the archive."

That was a coherent design position when it was written, and it is also wrong about what Back is
for. A reader does not experience "step to the next Digest" as a new place they went; they
experience it as adjusting what one screen — the Digest reader — is showing them, the same way
paging through search results or scrubbing a slider adjusts what one screen is showing. Nothing
about *which Destination they are in* changed. But because each step pushed a history entry, Back
did not treat it that way: a reader who stepped through five days and then pressed Back — meaning
"get me out of here" — got walked backward through all five days first, one press at a time,
before Back finally did what they wanted. On a phone, where hardware Back *is* browser back with no
separate affordance, that is not a minor rough edge; it is the control the reader reaches for most
reliably doing the opposite of what they asked it to five presses in a row.

The user's own framing of the complaint is the rule: "back is for screens and not within itself."
Back's job is to leave the screen (Destination) a reader is on and return them to the root screen
they left it from (ADR 0030). Adjusting what that screen is showing — which day, which Task, which
tab — is not leaving it, and asking Back to also unwind that adjustment, one step at a time, is
asking one control to do two unrelated jobs.

## Decision

**Back leaves the current Destination and returns to the root screen. Moving between a
Destination's own views, dates, or items is not leaving it, and must not push a history entry.**

A history entry is earned by a navigation a reader would name as "going somewhere else" — opening a
Destination from the root screen, following a link out of the app's own content into another
Destination. It is not earned by a navigation that keeps a reader inside the Destination they were
already looking at, however much the URL underneath them changes to reflect it. The test for which
category a given navigation falls into is not "does the URL change" — Digest's date-stepping
proves a navigation can change the URL and still be interior state — but "does the reader think of
themselves as still looking at the same screen." Stepping the Digest reader from one day to the
next is the second kind: same reader, same Digest reader screen, a different day of it.

### Digest date-stepping, worked

`DigestStepControl`'s `<Link>` gains `replace`. The date stays in the URL — reload, deep-link, and
share all still work exactly as they did, because ADR 0025's "the URL is the only state" reasoning
for why the date belongs in the URL at all is untouched by this ADR; only whether a step into that
URL adds to the stack changes. A reader who steps through several days and presses Back — hardware,
browser, or the reader's own app-bar arrow, all three routing through the same `goBack()` — leaves
the archive in one press and lands back on `/digest`, regardless of how many days they stepped
through first. This retires `digest-reader-page.tsx:49-66`'s "load-bearing for this ticket's own
acceptance criteria ('browser back walks the steps')" clause outright, and with it
`digest-reader-page.test.tsx:542`'s "browser back from a step returns to the prior Digest, not out
of the archive" — both asserted the position this ADR exists to reverse, and neither survives it.

`goBack()` itself needs no change. It already special-cases `location.key === "default"` (a cold
load or a deep link, with nothing behind it to pop) by navigating to `/digest` explicitly, and falls
back to `navigate(-1)` otherwise. Once stepping replaces instead of pushing, the reader's own entry
into the Digest reader (a push, from the `/digest` cards) is the only entry `navigate(-1)` ever has
to pop past — however many days were stepped through after that, they were never separate entries
to begin with.

## Alternatives considered

- **Keep the push, and change only the on-screen Back arrow to a hard link to `/digest`.** This
  would fix the arrow without touching `DigestStepControl` at all. Rejected: Android hardware Back
  is browser Back, not a call into this app's own component tree — it pops the same history stack
  `<Link>`'s push grew, regardless of what the on-screen arrow does. The complaint this ADR exists
  to fix would survive untouched on the one platform (a phone, using its own Back gesture or
  button) where it matters most.
- **Take the date out of the URL and hold it as component state instead.** This also stops stepping
  from growing the history stack, since there would be nothing to push. Rejected: it breaks the
  thing ADR 0025 already decided a Session-style resource needs — reload, a shared link, or a
  bookmark to one specific day's Digest all depend on the date being readable from the URL alone.
  Trading deep-linking away to fix a history-stack problem is fixing the wrong layer; `replace`
  fixes the actual layer without touching the URL's shape at all.

## Consequences

Every future Destination with more than one internal view or a steppable/paged item inherits this
rule by default: internal movement is `replace`, not push, unless a specific navigation is actually
a departure from the Destination the reader is currently on. A future author doesn't re-derive this
from first principles per Destination; they ask which of the two categories a given navigation
falls into and pick `replace` or a push accordingly.

**Todo is left non-compliant, on purpose, as a known follow-up rather than an oversight.** Two of
Todo's own internal navigations push today, in violation of the rule this ADR states:

- `/todo/inbox` → `/todo/today` (and every other row `TodoNav`/`TodoSidebar` render) is a plain
  `NavLink`, which pushes by default — moving between Todo's own views, exactly the case this ADR's
  rule covers, currently grows the history stack one entry per view visited.
- `todo-page.tsx:761`'s `closeTaskDetail` — `navigate(backgroundPath(backgroundView))` — closes the
  task detail view back onto its background with a plain (pushing) `navigate` call, not `replace`
  and not `navigate(-1)`. Closing a Task is exactly the "adjusting what one screen shows" case this
  ADR says must not push, and today it does.

Both predate this ADR and neither is touched by it — Todo is explicitly out of scope for the change
this ADR records, and fixing either means reasoning through `todo-page.tsx`'s own history-state
contract (`location.state.from`, the already-`replace`d `stepTaskDetail`, and `closeTaskDetail`'s
own comment on why it deliberately doesn't use `navigate(-1)`) on its own terms rather than as a
drive-by. That reasoning, and the fix, is future work this ADR names but does not do.
