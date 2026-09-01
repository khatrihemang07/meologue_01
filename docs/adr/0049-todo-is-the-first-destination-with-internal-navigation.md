# 0049: Todo is the first Destination with internal navigation

## Status

Accepted. Depends on
[0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md), whose retirement of the
persistent nav this ADR does not reopen — see *What 0036 was protecting, and why this does not
take it* below — and on [0018](0018-two-nav-destinations-across-three-routes-with-settings-as-an-app-bar-action.md),
whose three-to-five Destination bound the root screen still sits inside at five. Builds on
[0030](0030-the-shell-gets-a-root-screen.md), whose root-screen shape (a flat list of rows, each a
real link, opened by a full-bleed push) this ADR's fifth row inherits unchanged, and on
[0047](0047-a-task-is-a-second-root-noun.md), which is what gives Todo something of its own to
navigate between. Forward-references [0050](0050-tasks-are-ordered-by-fractional-index.md) for how
a Task is ordered inside whichever view is open, and issue #169 for the second view (Today) that
makes this ADR's navigation necessary rather than premature.

## Context

The root screen is a flat list a reader leaves (ADR 0036): four rows, each a Destination, each a
real link, each a full-bleed push that hides the list until Back returns to it. Todo becomes the
fifth. Inside it, Inbox lists every active Task with no Project. Issue #169 adds Today — a Task
whose Date, time or Deadline puts it in scope for today, unioned across two independent date
fields including undated Tasks with an arrived Deadline — as a second, co-equal view over the same
underlying Tasks. Upcoming and a Projects view are named in the programme's plan and deferred past
v1, but they are not hypothetical: Today alone is enough to make "how does a reader move between
the views Todo has" a question this ADR has to answer rather than defer.

That question sits directly on top of ADR 0036's argument, and it would be easy to answer it by
reading 0036 as "no navigation chrome, anywhere" and stopping there. That reading is too broad for
what 0036 actually decided, and the difference is the whole content of this ADR.

## Decision

**Todo carries navigation of its own, scoped to the Destination, and this does not reopen ADR
0036.**

### What 0036 was protecting, and why this does not take it

0036 deleted the persistent `<nav>` for one reason above the other two it also gave: the nav
"spent a permanent slice of the screen on a question already answered." A bottom bar cost around
56px of every page, forever, whether or not the page open at the time had any use for it — the
Composer paid the bar's height to advertise Reflect, Digest and Settings, and Reflect paid it right
back to advertise the other three. The cost was paid on every screen, unconditionally, for a
benefit — "where else can I go" — that a reader needs only occasionally and that the root screen
now answers for free once and lets the reader leave.

A bar scoped to Todo is a different trade, not a smaller version of the same one. It is mounted
only inside `/todo/*`, present only for a reader who has already made the deliberate choice to
enter Todo, and it leaves the component tree entirely — unmounted, not merely hidden — the instant
that reader navigates to any other Destination. Composer never pays for it. Reflect never pays for
it. The root screen never pays for it. The cost 0036 refused to pay everywhere is paid exactly
once, inside the one Destination whose own views are the thing the bar exists to move between.

Put the other way round: 0036's nav answered "where in the *app* can I go" and charged every
screen in the app for the answer. Todo's bar answers "where in *Todo* can I go" and charges only
Todo. Those are not the same question wearing two costumes; the first is a claim on the whole
shell, and the second is a claim on one Destination's own interior, which is exactly the kind of
decision a Destination is supposed to be free to make about itself.

### A Destination with several co-equal views has to offer a way between them

Inbox and Today are not one list looked at two ways. Today's own rule — Date or time due today,
overdue, or an undated Task whose Deadline has arrived — is a union across two independent date
fields, including Tasks that carry no Date at all. Getting from Inbox to Today is not a filter
click; it is opening a different query over the same Tasks, and Upcoming and Projects will add
more of the same. A Destination with several such views, none of them subordinate to the others,
has to expose a way to move between them, and the alternatives are worse:

- **A hamburger.** It buries the very thing a reader came to Todo to use — moving between its
  views is the ordinary case, not an edge case to tuck behind an icon that itself has to be
  discovered first.
- **A route with no visible affordance.** Reachable only by typing a URL or knowing the app well
  enough to guess one exists, which for a feature meant to be used constantly is a feature nobody
  finds.

A bar or rail scoped to Todo, matching the shape ADR 0030 originally gave the whole shell, is the
plain answer: visible, always in the same place while inside Todo, and gone the moment Todo is.

### What would reopen 0036

0036's cost argument is unconditional about *where else* chrome is allowed to be, even though it
says nothing against chrome scoped to one Destination's interior. Concretely, any of the following
would be the nav creeping back to where 0036 removed it from, not a Todo-scoped decision:

- **Navigation appearing on the root screen itself.** The root screen is the one place 0036's
  argument bites hardest — it is a list of five rows precisely so a reader learns the whole app's
  shape in one place and leaves. A row growing its own visible sub-navigation on the root screen
  before it is even opened is the persistent-nav cost paid on the one screen that exists to avoid
  it.
- **Navigation appearing on Composer, Reflect, Digest or Settings.** None of them has more than
  one view; none of them needs a way to move between views it doesn't have. A bar showing up on
  any of the four is not solving a problem those Destinations have — it is the old bottom bar
  wearing Todo's justification as cover.
- **Todo's own bar persisting once the reader has left `/todo/*`.** Scoping is the entire trade
  this ADR makes; a bar that survives navigation to another Destination has stopped being "the
  cost of Todo's interior" and become "the cost of the shell again," which is precisely what 0036
  argued against.

The shape of a test that would catch the third case — the one actually reachable by an ordinary
code change rather than a deliberate redesign — is a route-change test: render Todo, assert its
nav element is present, navigate to `/composer` (or any non-`/todo/*` route) through the router,
and assert the element has unmounted rather than merely being visually hidden. The first two cases
are structural rather than incidental — they would require deliberately adding a nav element to
`chat-list.tsx` or to a non-Todo page component — and the check for those is the same one 0036
already relies on: the root screen and the other four Destinations render exactly the landmarks
their own ADRs describe, and a second `<nav>` landmark appearing on any of them is a diff a
reviewer reads, not a runtime assertion this ADR invents new machinery for.

### The root screen stays a flat list you leave, not chrome that stays

Todo's fifth row is exactly like the other four: an icon, a label, a summary line, a full-bleed
push. Nothing about Todo having internal navigation changes what the root screen is. The reader
still leaves it to enter any Destination and still returns to it to leave any Destination; Todo's
bar exists entirely on the far side of that entry, inside the pane the root screen pushed to.

## Alternatives considered

- **One flat Todo view with a filter control instead of navigation.** Fewer concepts, and it looks
  like it avoids reopening 0036 by construction — there is no bar to argue about. Rejected: Inbox
  and Today are not two filters over one list. Today's rule unions two independent date fields and
  reaches undated Tasks (issue #169); a filter control expressive enough to state that rule ends up
  with the same set of named options, the same persistent control, and the same "which one is
  active" state that navigation already has — it is navigation wearing a `<select>`.
- **A separate top-level Destination per view** — Inbox, Today, Upcoming each its own row on the
  root screen. Rejected on two grounds at once. First, it re-argues ADR 0018's three-to-five bound
  by inflating five Destinations toward eight or nine as Upcoming and Projects land, when Material
  3's own reasoning for that bound — a nav a reader can hold in their head — does not stop applying
  just because the new rows are Task views rather than distinct apps. Second, it is worse in use:
  moving from Inbox to Today over the same underlying Tasks would mean leaving Todo entirely,
  landing on the root screen, and pushing back in — a trip through the one screen 0036 built to be
  left, for a move that should cost one tap.
- **Reinstating the persistent nav of ADR 0030 now that there is a Destination that wants one.**
  Rejected: 0036's cost argument — a permanent slice of every screen, spent on a question already
  answered — is exactly as true for Composer, Reflect, Digest and Settings today as it was when
  0036 removed it. One Destination wanting to navigate its own interior is not evidence that every
  screen wants chrome; it is evidence that this Destination's interior, specifically, has more than
  one thing to be.

## Consequences

Todo is the first Destination whose own route tree has a route tree of its own — `/todo/inbox`
today, `/todo/today` from issue #169, more later — and the pattern this ADR settles is the one any
future multi-view Destination has to justify independently rather than inherit for free: internal
navigation is earned per Destination by having more than one co-equal thing to show, not granted
by precedent because Todo has it.

The root screen's own claim — a flat list of five rows, none of them chrome — remains exactly as
strong as it was for four. Nothing about Todo's interior is visible from the root screen or from
any other Destination, and the check for that is a diff a reviewer reads on any change to
`chat-list.tsx` or to a non-Todo page, not a new kind of runtime enforcement this ADR had to
invent.
