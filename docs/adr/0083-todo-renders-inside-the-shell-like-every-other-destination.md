# 0083: Todo renders inside the shell like every other Destination

## Status

Accepted. **Supersedes [0076](0076-todos-navigation-is-what-the-shells-existing-pane-renders.md)**,
which is the whole of what this ADR does — 0076's pane swap is removed, not amended. Ratified by the
owner 2026-09-16 after using the built feature.

Restores [0030](0030-the-shell-gets-a-root-screen.md)'s claim that the root screen sits beside every
Destination at desktop width, which 0076 had conceded away for Todo alone. Leaves
[0049](0049-todo-is-the-first-destination-with-internal-navigation.md) standing: Todo still carries
navigation of its own, scoped to Todo, and that is still not a reopening of
[0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md). Only *where* that navigation
renders changes.

## Context

0076 decided that inside `/todo/*` at 900px and up, the shell's one pane renders `TodoSidebar`
instead of `ChatListPane`. Its argument was parity: Todoist's web application is a persistent left
sidebar beside a content column, and "make it exactly like Todoist" was the instruction the work
existed to satisfy.

The feature shipped, and the owner used it. The verdict was that Todo "seems like a completely
different page in itself" — that entering Todo makes the rest of meologue disappear, so Todo stops
reading as one of five Destinations and starts reading as a separate application that happens to
share a binary.

**0076 had already written down the evidence for this, and treated it as a cost rather than a
symptom.** Its own *What this does take* section concedes that the root screen is displaced rather
than pushed over; and it records that the displacement shipped with a defect nobody noticed until
issue #248 — a reader at desktop width had no way out of Todo at all, because `back-to-chats.tsx`
rendered nothing at the wide breakpoint exactly as it does everywhere else, while Todo's pane was
the one pane not showing the way back. #248 patched that with a carve-out: Back keeps rendering its
`<Link to="/">` on `/todo/*` regardless of width, the single route where that link does not
disappear at 900px.

A carve-out in a shared control, existing solely to re-supply a link the pane would otherwise have
provided, is the shape of a design working against itself. That is the reading this ADR takes.

## Decision

**The shell's pane always renders `ChatListPane`. `TodoSidebar` moves inside Todo's own subtree and
appears only at 1200px and up. Between 900 and 1199px, `TodoNav`'s bottom bar covers Todo's internal
navigation.**

Three bands, and the narrow one is untouched:

- **Below 900px** — unchanged in every respect. No pane, root screen is the whole screen, `TodoNav`
  is the answer. This is also the Android layout, and nothing here moves it.
- **900-1199px** — `ChatListPane` + `PaneDivider` + Todo's content, and `TodoNav` renders. Todo looks
  like Composer and Reflect look, plus its own bar.
- **1200px and up** — the same, and `TodoSidebar` renders as a second column inside Todo. `TodoNav`
  returns `null`, for the reason it always did: both carry `aria-label="Todo"`, and two nav landmarks
  with the same name on screen at once is a duplicate-landmark defect. Only the breakpoint moved.

`back-to-chats.tsx`'s `/todo/*` carve-out is removed. Back behaves identically on every route again,
because the premise the carve-out existed for — a pane that does not show the way out — is gone.

### What this takes

**0076's parity argument is dropped at desktop width, deliberately.** Todoist's web shell is one
sidebar beside one column; meologue at 1200px is now two navigations beside one column, which
Todoist is not. That is a real loss and it is the price of the decision, not an oversight. The
owner's framing — Todo should render "like composer or reflect" — is a claim about *this* app's
internal consistency, and it was taken as outranking per-Destination mimicry of the reference.
ADR 0082 already establishes that Todoist is the specification per platform; this ADR adds that
specification does not extend to dissolving meologue's own shell.

**The chat list now repaints under Todo's palette.** ADR 0069 scopes Todo's tokens by setting
`data-surface="todo"` on `documentElement`, and `ChatListPane` is now on screen while that attribute
is set. Under 0076 the pane was `TodoSidebar` whenever the scope applied, so no non-Todo surface
could be caught by it; that is no longer true. This is a consequence, recorded here rather than
fixed, because narrowing the scope is a change to 0069's own mechanism and belongs to it.

## Alternatives considered

- **`TodoSidebar` as a second column from 900px, with no new breakpoint.** The simplest rule, and
  rejected on 0076's own evidence: "two persistent panes at 900px leave the content column too
  narrow to hold Todoist's own row density." That argument does not weaken because the pane beside
  it changed identity — it is about available width, which is unchanged. Buying room with a
  breakpoint accepts the argument instead of disputing it.
- **`TodoNav` at every width, and delete `TodoSidebar`.** Smallest diff, and it would have made the
  four-tab work of ADR 0084 cover every platform at once. Rejected for 0076's reason, which survives
  this ADR intact: a bottom bar is the one piece of chrome that makes a Destination read as a phone
  app on a desktop.
- **Nest Todo's views inside `ChatListPane`, indented under the Todo row.** Closest to "the sidebar
  sticks as it is", and it needs no second column and no new breakpoint. Rejected because it makes
  the pane's contents route-dependent, which is precisely what 0036 built the pane not to be — the
  chat list is a list of the app's Destinations, and a list that grows and collapses a sub-tree
  depending on where the reader already is has stopped being that.
- **Leave 0076 alone.** Rejected by the owner on use. Worth recording that 0076 was not wrong on its
  own terms; it optimised for fidelity to the reference, and this ADR changes which thing is being
  optimised for.

## Consequences

Todo is no longer the exception in the shell. Every Destination at 900px and up now has the chat
list beside it, and `back-to-chats.tsx` has no per-route behaviour of any kind.

**A new band exists that nothing had before: 900-1199px, where both the chat list and a bottom bar
are on screen.** No prior ADR describes that combination, and it is the band most likely to be
overlooked when adding Todo navigation later — a change tested at 500px and at 1400px will miss it
entirely. It shipped with exactly that defect and it was caught here rather than in review: Todo's
Search door hides at 900px and `TodoSidebar` does not arrive until 1200px, so Search was briefly
unreachable across the whole band. ADR 0084's `Browse` tab is what closes it, which means the two
ADRs are load-bearing for each other at this one width.

The check that this ADR is still true is a render test per band, not a single wide/narrow pair:
at 1000px the chat list and `TodoNav` are both present and `TodoSidebar` is not; at 1200px the chat
list and `TodoSidebar` are both present and `TodoNav` is not.
