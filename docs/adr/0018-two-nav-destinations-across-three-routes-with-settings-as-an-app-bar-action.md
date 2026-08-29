# 0018: Two navigation destinations across three routes, with Settings as an app-bar action

## Status

Accepted. Partially supersedes the navigation described in [0009](0009-entry-store-and-sync-move-to-a-layout-route-above-history-and-composer.md)
— that ADR's route structure (`EntryStoreLayout` wrapping `/` and `/history`, Settings a sibling
outside it) stands unchanged and is still load-bearing; only the affordances for moving between
those routes are replaced.

Partially superseded in turn by [0020](0020-reflection-is-a-third-navigation-destination.md): this
ADR's exactly-two-destination count no longer holds — Reflection joined Composer and History as a
third peer inside `EntryStoreLayout`, still within the three-to-five range this ADR itself cited
from Material 3. Everything else here survives 0020 unchanged and is still load-bearing: Settings
stays an app-bar action rather than a nav destination, the Composer stays docked to the bottom
edge, the reading order and its view-only reversal are unchanged, and the day separators still
group through the same local-day helper Export uses.

Further superseded by [0030](0030-the-shell-gets-a-root-screen.md): History's route and page are
deleted outright — no redirect — because the Composer view already renders the identical `History`
component this ADR kept as a second, deliberately redundant door. Settings, which this ADR's
Decision section keeps out of the nav on the grounds that it is "a utility, not a peer of the two
views of a user's Entries," takes History's vacated slot instead, retiring that specific argument;
this ADR's citation of Material 3's three-to-five destination bound is what still licenses the
resulting four (Composer, Reflect, Digest, Settings). Everything else this ADR decided —
bottom-docked Composer, the reading-order reversal, the shared day-separator helper, one `<nav>`
repositioned by CSS rather than rendered twice — stands unchanged and is still load-bearing.

Superseded in its navigation technique by
[0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md) — the persistent `<nav>`
this ADR
argued for is deleted rather than repositioned, so the one-`<nav>`-repositioned-by-CSS technique
above (which 0020 and 0030 both left load-bearing) no longer describes anything in the tree. The
problem it solved does not arise on a shell whose navigation is a screen the reader leaves: there
is no navigation region present on every page to be one landmark or two. What that technique gave
for free — a real link per destination, a current-page marker, one navigation landmark — 0036 pays
for explicitly, and its own Status section says how. This ADR's bottom-docked Composer, its
reading-order reversal and its shared day-separator helper survive 0036 unchanged and are still
load-bearing; so does its argument that an always-reachable destination needs no Back, which 0036
applies at the wide breakpoint for exactly the same reason.

## Context

The app grew its navigation one ticket at a time and never had a layout pass. Every page was a
centred card floating in the viewport, and the way between pages was two unlabelled 16px icons in
that card's header plus a "Back" text link. The brief was to make navigation real and to make the
Composer and History read like a chat application.

Research into how chat applications actually navigate produced a finding that reframed the work.
They have **two levels**: a root screen — the conversation list — which carries the navigation
chrome, and a conversation screen, which is a full-bleed push that *hides* it. UIKit ships
`hidesBottomBarWhenPushed` for precisely this, and Apple's own guidance permits the tab bar to be
hidden only for a full-screen experience of exactly that kind. WhatsApp, Instagram, Telegram,
Signal and Slack all do it.

**meologue has no root level.** There is one thread and no thread list, so the screen it presents
is the conversation screen. That is why the pattern cannot simply be copied: there is no list
screen for a tab bar to belong to, and nowhere to return to from a hidden one.

## Decision

**Navigation carries exactly two destinations — Composer and History — and Settings is an action
in the app bar rather than a third.** Material 3 reserves a navigation bar for three to five
destinations *at the same hierarchy level*. Settings is a utility, not a peer of the two views of
a user's Entries; Telegram demoted Saved Messages into an overflow menu and Slack buries settings
under "More" for the same reason. Three routes remain (`/`, `/history`, `/settings`); only two of
them are destinations.

**The Composer's position and History's sort order are one decision, not two.** The Composer is
docked to the bottom edge, so the newest Entry sits nearest it and the thread reads oldest to
newest. Had the Composer stayed at the top, newest-first would have remained correct. These two
were deliberately never allowed to be chosen separately, because a bottom-docked Composer with
the newest Entry at the far top is the specific arrangement that reads as broken.

**The reading order reverses in the view only.** `EntryStore.list()` still returns newest-first,
and `search()` still returns results in the same order as `list()` — the guarantee
[0014](0014-entry-search-hand-maintained-fts5-index.md) makes. Nothing in `packages/core` changed.
Both destinations apply the same reversal after Search narrows the thread, so a query cannot flip
the reading order.

**Day separators group by the local day, through the same helper Export groups its day files
with** ([0016](0016-export-per-day-text-plus-a-lossless-manifest-grouped-by-local-day.md)). Sharing
the rule rather than restating it is what makes the days a reader sees and the days an Export
writes agree near midnight, by construction rather than by two implementations happening to match.

**Navigation is one element in the DOM, repositioned by CSS** — a bottom bar on a narrow window,
a rail on a wide one. Rendering it twice and toggling `display` was tried first and rejected: it
puts two identical landmarks in the accessibility tree, announces the whole navigation twice to a
screen reader, and makes every link match twice.

## Alternatives considered

- **Bottom tab bar plus a docked Composer.** Both want the bottom edge; together they stack about
  120px of permanent chrome on a phone. No chat application does this.
- **A tab bar hidden on the thread, per `hidesBottomBarWhenPushed`.** The industry-standard answer,
  and rejected only because it needs a root screen to return to, which this app does not have.
- **Merging `/` and `/history` into one route.** They render overlapping content, and two
  destinations pointing at similar screens is a real cost. Rejected deliberately: the separation
  was kept, and the redundancy accepted, in exchange for History remaining directly addressable
  and hard-reloadable.
- **A user-switchable rail-or-bottom-bar setting**, as Telegram ships. Rejected as a setting that
  exists to avoid making the decision.
- **Keeping "Back".** Removed: with both destinations always reachable, a back affordance only
  described where the user had been, not where they could go.

## Consequences

Because the two destinations show overlapping content, the navigation advertises a redundancy the
old single icon merely hid. That is a known, accepted cost of keeping both routes.

Search moved into the app bar and became a mode rather than a place, which is what finally makes
the UI agree with the glossary's own definition — Search "narrows History in place rather than
producing a separate collection". A future reader finding no search box on the page should look in
the app bar, not conclude it was lost.

A History shorter than the viewport is bottom-aligned rather than top-aligned. Without that, the
newest Entry sits at the top of a screen of empty space with the Composer far below it — and since
the pin only engages once content overflows, that was the state every new Device started in.

`CONTEXT.md` gained **Composer** as a term. It was already this codebase's word for the view, used
throughout and in 0009, but had never been defined. "Log" was explicitly rejected as a name for
that destination, because the glossary's opening line already uses it for the whole application.
