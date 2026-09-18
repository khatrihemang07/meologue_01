# 0076: Todo's navigation is what the shell's existing pane renders

## Status

**Superseded by [0083](0083-todo-renders-inside-the-shell-like-every-other-destination.md)**
(2026-09-16). The pane swap this ADR decided is gone: the shell's pane always renders `ChatListPane`,
and `TodoSidebar` moved inside Todo's own subtree at a 1200px breakpoint. The owner's verdict on using
the built feature was that it made Todo read as a separate application rather than one of five
Destinations. 0083 also removes the `back-to-chats.tsx` `/todo/*` carve-out that issue #248 added
below, since the pane now shows the way out on every route. Everything under *What this does take*
is therefore history, not current behaviour — read it for why the trade was made, not for what the
code does.

Originally accepted. Amends [0049](0049-todo-is-the-first-destination-with-internal-navigation.md) at one
breakpoint, and **concedes that [0030](0030-the-shell-gets-a-root-screen.md)'s "every Destination is
a full-bleed push" stops being true for Todo at desktop width** — see *What this does take* below.
Builds on [0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md), whose pane this
reuses rather than adds to, and on [0069](0069-todo-renders-through-its-own-token-scope.md), which
is what lets the pane repaint without the rest of the shell repainting with it.

**Renumbered from 0070 to 0076 by issue #248**, which found this file sharing its number with
[0070](0070-the-composer-keeps-tab-and-shift-tab-in-bare-prose-is-the-keyboard-exit.md) (an
unrelated Composer-keyboard decision — every "ADR 0070" citation in `composer-commands.ts` and
elsewhere means that one, not this one). This file moved rather than the other, since it has far
fewer citations to correct; every citation of this ADR across the repo (`docs/adr/0069-…`,
`check-bundle-size.mjs`) was updated in the same change.
**Also amended by issue #248**, which built the Back control *What this does take* below had only
asserted — see that section for what changed and why.

## Context

Todoist's web application is a persistent left sidebar beside a content column: Add task, Search,
Inbox / Today / Upcoming / Filters & Labels with counts, a Favourites section, and a project tree.
An exact clone of Todoist has that shape. This app deliberately does not — ADR 0036 deleted the
app-wide persistent nav, and ADR 0049 argued at length that Todo's own bottom bar is not a
reopening of that decision.

It would be easy to read those two ADRs as "no persistent navigation, anywhere" and stop. That
reading is broader than what was actually decided, and the difference is this ADR.

**0036's argument was about cost, and it was specific.** The nav "spent a permanent slice of the
screen on a question already answered": roughly 56px of every page, forever, whether or not the page
open at the time had any use for it. The Composer paid the bar's height to advertise Reflect; Reflect
paid it back to advertise the Composer.

**That cost is already being paid here, and not by this ADR.** At the wide breakpoint,
`chat-shell-layout.tsx` *already* renders a left pane — `ChatListPane`, a divider, and a
user-draggable persisted width. ADR 0036 put it there. So the question this ADR answers is not
"should Todo add a permanent pane" but "what should the pane that already exists show while the
reader is inside Todo".

## Decision

**Inside `/todo/*` at the wide breakpoint, the shell's existing pane renders `TodoSidebar` instead
of `ChatListPane`. Below that breakpoint nothing changes at all.**

No second pane, no second divider, no second width mechanism. The clamp, the drag, the persisted
width and the `--list-w` variable are ADR 0036's and are reused untouched.

`TodoNav`'s bottom bar hides itself at the wide breakpoint, because the sidebar has taken over its
role and both carry `aria-label="Todo"` — two nav landmarks with the same name on screen at once is
the duplicate-landmark defect `chat-list-pane.tsx` already argues a `<div>` instead of a `<header>`
into existence to avoid, rebuilt on the other axis. Below the breakpoint the bar renders exactly as
it always has.

### What this does not take

ADR 0049's line holds. The sidebar is mounted only inside `/todo/*` and leaves the component tree
entirely — unmounted, not hidden — the instant the reader navigates anywhere else. The Composer
never pays for it. Reflect never pays for it. It remains a claim on one Destination's own interior,
which is precisely the kind of decision 0049 says a Destination is free to make about itself.

### What this does take

**ADR 0030's root screen is displaced rather than pushed over, for Todo, at ≥900px.** 0030's shape
is a flat list of rows the reader leaves by a full-bleed push, and at desktop width a reader who
enters Todo no longer has that list beside them — they have Todo's own navigation instead. That is a
real amendment and it is stated here rather than smoothed over. The root screen is still how the
reader *arrives*, and Back still returns them to it — but not, the way it does for every other
Destination at this breakpoint, because the root screen is already visible in the pane and Back can
therefore render nothing (`back-to-chats.tsx`'s own rule, unchanged for Composer, Reflection, Digest
and Settings). Todo's pane never shows the root screen at this breakpoint; it shows `TodoSidebar`,
which is navigation *within* Todo and carries no link to the other four Destinations. That gap
shipped unnoticed until issue #248: `back-to-chats.tsx` rendered nothing at the wide breakpoint on
`/todo/*` too, exactly as it does everywhere else, which left this paragraph's claim false in the
one place it mattered — a reader at desktop width had no way out of Todo at all except the browser's
own back button or typing a URL. #248 fixed it the direct way: `back-to-chats.tsx` now keeps
rendering its `<Link to="/">` on `/todo/*` regardless of width, the one route where that link does
not disappear at ≥900px. What changes at this breakpoint, accurately stated, is only that the pane
stops *showing* the root screen while the reader is inside Todo — Back returning them to it is a
control this ADR now actually builds, not a fact the pane's own presence used to make true for free.

Below the breakpoint, none of this applies: there is no pane, the root screen is the whole screen,
and `TodoNav` is still the answer. So 0049 is amended at one breakpoint, not replaced — and the
narrow layout, which is also the Android layout, is untouched. That constraint is held by a test
rather than by this paragraph.

## Consequences

The pane now shows one of two things depending on route, which means a reader at desktop width sees
Todo's own navigation and the chat list at different times rather than together. That is the trade:
agreement with the source this feature was measured against, paid for in one Destination's
interior, at one breakpoint.

Because ADR 0069 scopes the palette to the same subtree, the pane also repaints while Todo is open
and returns to the app's own palette when it is not — one attribute, set on the element both the
pane and the page already share.

Todo also gained a second, independent case of the same "two navigations, one list of destinations"
gap this ADR's own Decision section already names for `TodoNav` vs. `TodoSidebar`: `/todo/activity`
was added to `TodoNav`'s `VIEWS` (ADR 0056) but never to `TodoSidebar`, so it was unreachable from
the wide-breakpoint sidebar for the life of the branch — the identical defect class Upcoming shipped
with (issue #223), fixed the same way issue #248 fixed Back: by adding the missing row to the list
that was missing it.

## Alternatives considered

- **Add a third pane for Todo, beside the existing one.** Rejected: two persistent panes at 900px
  leave the content column too narrow to hold Todoist's own row density, and it would genuinely be
  the permanent-slice cost 0036 refused, rather than a reuse of a slice already spent.
- **Keep `TodoNav` at every width and skip the sidebar.** Rejected: it is the one visible piece of
  chrome that makes the destination read as a phone app on a desktop, and "make it exactly like
  Todoist" was the instruction this work exists to satisfy.
- **Put the sidebar inside `Shell` instead of the pane.** Rejected: `Shell` sits inside the pane's
  sibling, so a sidebar there would render beside the content *within* the destination, leaving the
  chat list still occupying the real pane — two lists, one of them irrelevant.
