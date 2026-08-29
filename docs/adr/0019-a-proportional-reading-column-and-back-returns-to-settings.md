# 0019: A proportional reading column, and Back returns to Settings

## Status

Accepted. Partially supersedes [0018](0018-two-nav-destinations-across-three-routes-with-settings-as-an-app-bar-action.md)
— that ADR's two-destination navigation, its bottom-docked Composer, its reading order and its day
separators all stand unchanged and are still load-bearing. Two things in it are replaced: the fixed
reading-column width it inherited from ticket 50, and its rejection of a Back affordance, which was
listed there under *Alternatives considered* and is un-rejected here for Settings only.

This ADR's own "Back returns to Settings" clause is retired outright, not amended, by
[0030](0030-the-shell-gets-a-root-screen.md): Settings became the fourth persistent Nav destination
there, which is precisely the condition this ADR's own Decision section says Back doesn't apply
to — "with both destinations always reachable, a back affordance only described where the user had
been, not where they could go" is 0018's argument, and this ADR only ever carved Settings out of it
because Settings wasn't a destination yet. Once it is, that carve-out has nothing left to except.
The proportional reading column this ADR decided is untouched by 0030 and still governs every
route, including the three that remain inside `EntryStoreLayout`.

Composed with, not superseded by,
[0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md). The proportional reading
column still governs
every destination's content; what changes is what it is proportional *to* — at the wide breakpoint
the column now fills the open pane rather than the window, because the chat list takes a share of
the window beside it. This ADR's own category argument, that a reading width is a per-Device view
mechanic rather than something the glossary names, is what 0036 reuses for the pane divider's
stored width, for Accent and for text size.

## Context

The reading column had been capped at `max-w-2xl` (672px) since ticket 50 introduced the app shell,
a width taken from the chosen prototype (#49 variant 08). On a phone that cap never binds — the
window is narrower than 672px, so the column is effectively full-width. On a 1512px laptop it binds
hard: the content occupies 44% of the window and the app reads as a narrow card floating in empty
space, which is precisely the look the shell was meant to replace.

Separately, Settings is not a navigation destination. 0018 made it an app-bar action on the grounds
that Material 3 reserves a navigation bar for three to five destinations *at the same hierarchy
level*, and Settings is a utility rather than a peer of Composer and History. It is reachable from
exactly two places — the app bar on `/` and on `/history` — and nothing in the app returns from it
except the persistent nav, which lands on a destination rather than on wherever the reader came
from.

## Decision

**The reading column is proportional, not capped: 97% of the window below the `md` breakpoint, 85%
of the space beside the rail at or above it.** Both `shell.tsx`'s content column and `composer.tsx`'s
docked bar carry the identical pair of percentages; they are a coupled pair, and the moment they
disagree the input stops lining up with the thread above it.

The percentage is taken of the *containing block*, which above `md` is the window minus the 80px
rail rather than the window itself. That falls out of the flex layout rather than being computed, so
there is no rail width hardcoded anywhere for it to drift from.

**This deliberately accepts a line length past every published guideline on a wide window.** The
numbers were measured, not estimated: at 1512px the column is ~1217px, leaving ~1139px of body text
after the gutter and the right-aligned clock time — on the order of 160 characters per line at
`text-sm`, against ~85 today. Bringhurst puts a single column at 45–75 characters; Dyson and
Haselgrove found on-screen reading fastest in a 55–100 band with comprehension falling away past
100. The trade was made with those numbers in hand, on the grounds that `CONTEXT.md` defines an
Entry as "a single fleeting thought": most Entries do not fill one line at *any* width, and a thought
of ten words pays no return-sweep cost however wide the column is. The reader who writes long
Entries pays for the reader who writes short ones. That is the accepted cost, not an oversight.

**The column steps *down* as the window widens across `md`.** 85% is smaller than 97% at every
window size, so there is no breakpoint at which the flip is a widening; a 767px window gets a wider
column than a 768px one. `md` was chosen for the step because the navigation already transforms
there — bottom bar to left rail — so the width change rides along with a transition the eye is
already tracking, instead of introducing a second, separate moment where the layout jumps.

**Settings regains a Back affordance, and it is a real history pop.** 0018 removed "Back" because
"with both destinations always reachable, a back affordance only described where the user had been,
not where they could go." That argument is still correct *for destinations* — neither Composer nor
History gets one. It does not hold for Settings, which is not a destination: it is a utility entered
from exactly two pages, and "where the user had been" is the only useful thing to say about leaving
it.

Back runs `location.key === "default" ? navigate("/") : navigate(-1)`. The `"default"` check is not
a heuristic: react-router falls the current location's key back to that literal string when the
browser's history state carries no key of its own
(`react-router/dist/development/lib/router/history.js:144`), which is exactly the fresh-load,
direct-deep-link and hard-reload-with-nothing-behind-it case — the case where `navigate(-1)` would
walk the reader out of the app entirely. Memory history seeds its first entry the same way
(`history.js:49`), which is what makes the rule testable without a browser.

**The persistent Nav stays on Settings alongside Back.** Removing it would strand History behind two
taps and contradict 0018's "every page becomes reachable directly."

## Alternatives considered

- **A larger fixed cap** — `max-w-4xl` (896px, ~117 characters per line). The typographically
  defensible answer, and rejected because on a 1512px screen it still fills only 59% of the window:
  it moves the number without changing what the app looks like.
- **A percentage *with* a cap.** Rejected once the arithmetic was worked through: under a cap the
  percentage is inert exactly where it was wanted (at 1512px, 85% of 1432px exceeds any cap worth
  setting, so the cap decides) and *narrower* than doing nothing in the 768–870px band. A cap and a
  proportion cannot both be in charge.
- **Capping `EntryBody` at ~70ch while the row itself stretches.** Typographically the correct
  answer — it would deliver a filled window *and* a readable measure. Rejected as a third place to
  keep in sync, and because it leaves the row visibly ragged, with the clock time stranded far right
  of a short line.
- **Flipping the width at `lg` rather than `md`.** A smaller step (113px rather than 160px) and it
  keeps tablets near-full-width, at the cost of a second breakpoint that has to stay identical
  across two files, and a width jump at a point where nothing else about the layout changes.
- **A fixed `<Link to="/">` for Back.** Simpler, keeps an `href`, and survives a hard reload — it is
  what the fallback branch does. Rejected as the *whole* rule because it throws away the one thing
  Back is for: Settings is reached from two pages, and a fixed target sends the History reader to
  the Composer.
- **`window.history.length` to detect an empty history.** Rejected because it lies: a fresh tab
  reports 1 and so does a tab that navigated in from another site, so it cannot tell the two apart.

## Consequences

A long Entry on a wide window will be harder to read than it was, and that is a known, accepted,
measured trade rather than a regression to be filed. Should it prove intolerable in use, the cheapest
retreat is a cap (`md:max-w-4xl`), and the argument against it is recorded above rather than lost.

Back is a `<button>`, not a `<Link>` — a history pop has no URL to put in an `href` — so it has no
middle-click and no open-in-new-tab. Inherent to choosing history over a fixed target.

Settings now has two affordances that both lead towards the Composer: Back, and the Nav's Composer
destination. This is the second redundancy this navigation has knowingly accepted, after 0018's two
destinations showing overlapping content. It is recorded rather than resolved because the two say
different things — Nav says *where you can go*, Back says *where you were*.

`CONTEXT.md` is unchanged. Nothing here introduces a domain concept; a reading column and a back
affordance are both view mechanics, and the glossary is not the place for them.
