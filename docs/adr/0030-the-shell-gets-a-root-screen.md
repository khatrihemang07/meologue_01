# 0030: The shell gets a root screen

## Status

Accepted.

Partially supersedes [0018](0018-two-nav-destinations-across-three-routes-with-settings-as-an-app-bar-action.md)
and its own amendment via [0020](0020-reflection-is-a-third-navigation-destination.md) — the
route that carried "History" as a nav destination is deleted outright, and Settings, which 0018
deliberately kept out of the nav as "a utility, not a peer," becomes the fourth destination in its
place. 0018's reasoning for a bottom-docked Composer, the reading-order reversal, the shared
day-separator grouping, and the one-`<nav>`-repositioned-by-CSS technique all stand unchanged and
are still load-bearing.

Partially supersedes [0019](0019-a-proportional-reading-column-and-back-returns-to-settings.md) —
its "Back returns to Settings" clause is retired outright, not amended in place: 0019 built Back
specifically because Settings was reachable but not itself a destination ("where the user had
been" was the only useful thing Settings could say about leaving). Settings is now one of the
persistent Nav's own four destinations, so 0018's original argument against Back on a destination
("with the destination always reachable, a back affordance only described where the user had
been, not where they could go") applies to Settings for the same reason it always applied to
Composer, Reflect and Digest. 0019's proportional reading column is untouched and still governs
every route, including the three that remain inside `EntryStoreLayout`.

Partially supersedes [0020](0020-reflection-is-a-third-navigation-destination.md)'s destination
count and its own later amendment note (which had already moved the count from three to four by
adding Digest, without changing which four): the count stays four, but the membership changes —
Composer, History, Reflect, Digest becomes Composer, Reflect, Digest, Settings. Everything else
0020 decided — the `/reflect` route inside `EntryStoreLayout`, the Sync-off gate, Settings staying
a sibling route outside that layout — stands unchanged and is still load-bearing.

Knowingly deviates from [0005](0005-one-vite-application-build-time-platform-seam.md) in one
narrow place — see **The send chord branches in a shared module** below. 0005's build-time seam
itself is untouched and still governs every existing platform difference; what this ADR departs
from is its *Alternatives considered* rejection of branching on the target inside one shared
module.

Extends [0016](0016-export-per-day-text-plus-a-lossless-manifest-grouped-by-local-day.md) rather
than superseding it: `EntryStore.list()` gains an optional keyset page argument, and 0016's own
"a backup that quietly omits things is worse than none" reasoning is why that argument had to stay
optional — Export calls `list()` with none, gets every Entry exactly as before, and needed no
change of its own.

Partially supersedes [0025](0025-sessions-are-held-by-the-server.md)'s "the Device stores nothing
at all" clause — the Device now remembers one Session id, in `sessionStorage`, as a fallback for a
bare `/reflect`. Everything else 0025 decided — the Server as sole holder of Session content, the
URL as the authoritative id, no local mirror of a Session's Conversation — stands unchanged and is
still load-bearing; see this ADR's own Decision section for why the reversal is narrow.

Does **not** amend [0027](0027-digests-are-written-ahead-of-time-by-a-background-worker.md) or
[0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md). The Digest prompt wording
changed in this batch, but 0027 governs the worker's scheduling and immutability model, not prompt
copy. 0028 governs why Edit and Delete exist on an Entry at all (mutability, a compacted change
log) and, despite `entry-row.tsx` once citing it in a comment that suggested otherwise, never chose
the widget that exposed them — that comment has been corrected in place, and this ADR's row-actions
section is the decision 0028 never made.

Superseded in its strongest form by
[0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md). This ADR is titled "the shell
gets a root
screen" and its Decision never built one — what it actually decided was which four destinations
the persistent nav carried, with `/` still the Composer. 0036 is that root screen: `/` becomes a
chat list of the same four destinations and the Composer moves to `/composer`. The membership
decision here survives intact, and so does everything this ADR decided about `EntryStoreLayout`,
the Sync-off gates, Settings as a sibling route outside the store, and the row actions
`entry-row.tsx` exposes — though 0036 replaces the touch *gesture* that reaches them, a tap, with
a leftward swipe, and adds Copy to the sheet.

## Context

The shell had grown for several tickets straight without a pass back over what it had accumulated.
Five things had drifted far enough from how the app was actually used that they surfaced as bugs
rather than as backlog items, in the course of implementing and then hand-verifying issues #75
through #84 on a real Android device and against the Sandbox's seeded corpus:

- **History was a second door onto a room the Composer already showed.** `/history` rendered the
  identical `History` component with identical props to `/`, a redundancy ADR 0018 took knowingly
  to keep it directly addressable. Once the Composer view read as the app's main screen, the
  second door stopped earning its place in a four-destination nav, and Settings — demoted to an
  app-bar gear by 0018 specifically because it wasn't a peer of Composer and History — had nowhere
  else obviously better to go than the slot History left behind.
- **Every Entry row was wrapped in a Radix `ContextMenu`, and it broke two things at once.** Radix's
  `asChild` Slot merges the trigger's own `select-none` onto the row's `<div>`, which is why Entry
  text could not be dragged to select on any platform — proven by the identical `EntryRow` in
  `grounding-disclosure.tsx`, which passes no actions, renders bare, and was selectable all along.
  Separately, `@radix-ui/react-menu` registers one document-level keydown-capture listener per
  mounted root — a few hundred Entries meant a few hundred listeners added on mount and removed on
  unmount, the dominant cost of navigating to and away from a long History, and the reason leaving
  was slow too.
- **`EntryStore.list()` had no bound.** It read and rendered every Entry a Device held, on every
  load — fine at the corpus sizes early tickets tested against, and a real cost once a Device's
  History actually grew.
- **A Conversation lived only in memory, per ADR 0020's own deliberate deferral, and Reflect's Nav
  link was a bare `/reflect`.** Once ADR 0025 gave Sessions somewhere durable to live, leaving
  Reflect for the Composer and coming back discarded whatever Session had been open — not a bug in
  0025, exactly the design it shipped — but the fifteen seconds of inference behind a real Answer
  made that discard newly costly.
- **Digest and Reflection's prompts both fought their own instructions.** Reflection told the model
  to answer "in a few sentences" regardless of how much Grounding stood behind an Answer, and the
  Digest prompt said "a short piece of prose" in the same paragraph as "no length target to hit" —
  a contradiction a model resolves in favour of the first, shorter instruction it read.

None of these were designed wrong the first time; each was correct for the app that existed when
it shipped. This ADR records what changed once the app's own use — reading History, editing on
mobile, a Reflect Session worth returning to — put pressure on assumptions each earlier ADR made
explicitly and reasonably at the time.

## Decision

**Navigation carries four destinations — Composer, Reflect, Digest, Settings — and History has no
destination, route or redirect.** `/history` and `history-page.tsx` are deleted outright rather
than redirected to `/`: the Composer route already renders the same `History` component with the
same props (`composer-page.tsx`'s `footer` slot), so a stale link to `/history` finding nothing is
the honest state of the world, not a gap to paper over with a redirect to a page that says
something different at the same URL. Settings takes History's old slot in `nav.tsx`'s
`DESTINATIONS`, the app-bar gear (`SettingsLink`) is deleted, and Settings' Back button
(`settings-page.tsx`) goes with it — Shell's `back` slot stays, unused today, because ADR 0008/0009
still requires Settings to render *something* through the same `Shell` every other page uses, and a
`ReactNode` slot Shell doesn't have to understand routes to render is cheaper to leave than to tear
out for a future page that might want it. **`/settings` stays a sibling route outside
`EntryStoreLayout`**, unchanged from ADR 0008/0009 and unaffected by where the Nav renders its
link: it must keep working when the Entry store never opens, because that is how a bad Server URL
gets fixed, and only *how a reader reaches it* moved, never what it depends on.

**The per-row `ContextMenu` is gone, replaced by the Slack/Discord split on hover capability, not
on build target.** `entry-actions.tsx`'s `hoverCapable()` reads `window.matchMedia("(hover:
hover)")` at the moment of each render or tap, because hover capability is a property of the
device, not of which of web/Android/macOS happens to be running (a touchscreen laptop and a phone
can both run the "web" build). A hover-capable device gets `EntryHoverActions`: two plain
`<button>`s, `display: none` outside `(hover: hover)` so they occupy no tab-order slot on a device
that can never reach them, revealed via `opacity` on `:hover` or `:focus-within` so keyboard focus
alone can still surface them. A touch device gets `EntryActionsSheet`: one bottom sheet owned by
`history.tsx`, driven by a single "which Entry is open" state, so exactly one instance exists no
matter how many rows render. Neither replacement is a Radix menu root of any kind — plain DOM,
zero additional document-level listeners, which is what actually removes the per-row cost that
motivated the change, not merely the gesture that triggered it. **Long-press is left alone on both
platforms** — that is what lets a device's own native text selection work, and it is the whole
reason the old trigger had to go rather than be re-gated.

That decision needed a follow-up once it met a real Android device: **a click is disqualified from
counting as a tap if the press lasted longer than 400ms, or if it lands while text is
selected.** Android's WebView fires an ordinary `click` when a long-press is released, indistin-
guishable from a quick tap by the click event alone, so the row's tap handler
(`handleRowTap`) was opening the actions sheet over a selection the platform was in the middle of
starting. 400ms sits above a deliberate tap and below Android's own roughly 500ms long-press
threshold; the selection check (`!window.getSelection()?.isCollapsed`) catches the release at the
end of a drag-select and the click that dismisses one. Verified on the device: long-press now
selects the word and raises Android's own Copy/Share/Select-all toolbar, with no sheet.

**`EntryStore.list()` gains an optional keyset page argument; called with no argument it behaves
byte-identically to before.** That optionality is the entire mechanism that keeps ADR 0016's Export
guarantee intact without Export changing a line — Export still calls `list()` with nothing and
still gets every Entry, because 0016 already established that a backup which quietly omits things
is worse than none. `search()` stays unbounded for the same reason it always was: it narrows in
place and its result sets are small. The client moves to `useInfiniteQuery` at 50 per page,
flattened to a plain `Entry[]` at the hook boundary so no consumer learns pages exist; nothing is
prefetched, and an older page is fetched only once the reader actually reaches the top of what's
loaded, adjusting `scrollTop` by the measured height delta so the viewport doesn't jump. Refreshes
are bounded to the newest page — a sync tick or a Send used to invalidate the whole infinite-query
key, which would have refetched every page held and made each tick progressively more expensive
the further back a reader had scrolled, exactly backwards from the goal. `refetchOnWindowFocus` is
off for the Entries query specifically, because `wake-signals` already subscribes to focus and
`visibilitychange` and drives the same bounded page-0 refresh through the sync loop, so the
built-in refetch would only add a second, redundant path to the identical outcome.

Paging surfaced a real regression in a promise CONTEXT.md makes about **Grounding**: Reflection had
resolved each Grounding Entry id by scanning the array the page's outlet context handed it — the
whole History before paging, only the loaded window after. A Grounding id outside that window
rendered the "this Entry hasn't reached this Device yet" placeholder, which is false — the Entry
had reached the Device and simply wasn't in the scanned array. `EntryStore` gains `getMany(ids)`, a
direct by-id read that bypasses `list()` and its paging entirely, omits tombstones (ADR 0028) and
unknown ids alike, and is the only case left that the "hasn't reached this Device yet" message may
honestly describe. Because the lookup is now async where the array scan was synchronous, an
unresolved id renders a neutral loading placeholder rather than risk the dishonest "not here"
message during the gap before the query settles — CONTEXT.md's Grounding entry requires an
Answer's disclosed basis to be honest, and a resurrected-then-corrected false negative would have
violated that as surely as an invented one.

**History renders as one flat virtualized item list**, day separators flattened in alongside Entry
rows, via `@tanstack/react-virtual` with dynamic measurement (Entry text wraps to variable
heights). Three behaviours the un-virtualized list had needed deliberate replacement:

- The day separator was `position: sticky`, which cannot work inside an item wrapper positioned by
  `transform` — a transformed ancestor gives its descendants a new containing block. Separators
  stay inline in the flattened list; one always-present overlay pill, computed from the
  virtualizer's own visible range, sits as a sibling above it and is suppressed when the topmost
  visible row is already that day's own separator, so the day never appears twice at once.
- A History shorter than the viewport still sits bottom-aligned against the Composer, the behaviour
  ADR 0018's Consequences records. That alignment is now a computed leading spacer rather than
  `justify-end`, and Shell's own bottom-alignment logic is switched off specifically for this page:
  running both at once is a genuine feedback loop, each correcting for the other's last correction
  and converging on roughly half the needed value.
- Jump-to-newest can no longer be `scrollTop = scrollHeight`, because only the virtualizer can reach
  a row it hasn't measured yet. `History` registers a `scrollToIndex` callback upward through
  context; the hook that used to own this falls back to the old `scrollTop` behaviour for
  Reflection's Conversation, which shares the hook but isn't virtualized. Measured row sizes are
  keyed by Entry id, not index, so they follow a row across a page prepend rather than staying
  pinned to a position that now holds a different row.

**Caveat recorded rather than hidden: jsdom has no layout.** `getBoundingClientRect` always reports
zero size under jsdom, so `virtual-core`'s range calculation bails to an empty range and
`measureElement` reports zero for every row. The component falls back to estimate-positioned items
(`ESTIMATED_ROW_HEIGHT_PX = 56`, `OVERSCAN = 25` to keep every fixture-sized test list actually
rendered and queryable) whenever a real measurement comes back zero. This means the unit suite
exercises that fallback path, not the real virtualizer — only a real browser proves this ticket,
and that distinction is worth a reader knowing before trusting a green `vitest` run as proof of
virtualization behaving correctly.

**Delete now asks first, through one shared confirmation dialog, replacing the Undo toast rather
than joining it.** The prior design deleted an Entry the instant Delete was chosen, with a
ten-second Undo toast as the only way back — a design that made sense while Delete lived behind a
long-press-into-a-menu gate, but that gate is exactly what the row-actions change above removed:
Delete is now a single visible button, and the argument for going straight through no longer held.
`ui/alert-dialog.tsx`'s `ConfirmDialog` is one component used twice — by History for an Entry, by
`sessions-page.tsx` for a Session, which carries its own warning that deleting removes the
Conversation from every Device — differing only in its `title`/`description`/`confirmLabel` props.
It is built on Radix `Dialog` with `role="alertdialog"` set by hand, not on Radix's own
`AlertDialog`: `AlertDialogContent` hardcodes `preventDefault` on outside pointer/interact events
with no compose-with-caller escape hatch, and this dialog is required to close on an outside click.
Cancel is auto-focused on open, reproducing by hand the one thing `AlertDialogContent` would have
given for free, so a stray Enter never lands on Delete. Undo is gone entirely, including the
restore path that had to mint a new id to work around the server's `where entries.deleted_at is
null` guard (ADR 0028) making a delete terminal for an id — that reasoning is kept as a comment
rather than deleted, since it's exactly why a restore path could never simply "come back."

**Reflect resumes the Conversation a reader left, reversing part of ADR 0025 in one narrow
direction.** 0025 was explicit that the Device stores nothing and the URL is the only state; that
was correct while a Conversation was cheap to lose. Once a Session held real inference behind it,
leaving Reflect for the Composer and returning to a bare `/reflect` silently discarded whatever was
open. `lib/last-session.ts` remembers exactly one Session id in `sessionStorage`, under
`meologue.last-session-id`, following the precedent `use-history-search.ts` already set for
Search's own query — `sessionStorage`, not `localStorage`, because this is "where you left off in
this tab," not a Device-wide preference, and a fresh tab should not resume a Conversation some
other tab happened to leave open. Every access is wrapped in try/catch and degrades to "nothing
remembered," matching `settings.ts`'s existing rule for storage that can throw in some privacy
modes. **The memory is a fallback for a bare `/reflect` only, never an override of an explicit id
already in the URL** — a reload still restores a Conversation from the URL alone, exactly as 0025
built it, so the part of 0025 this reverses is genuinely narrow: what a bare, id-less `/reflect`
resolves to, not how an explicit Session id is read. A Session deleted from another Device clears
the remembered id (discovered via a 404 on fetch) and lands the reader on a fresh Reflection
silently, with no way to loop back into the dead id. `NewSessionLink` gives the deliberate way out
of an accidentally-resumed Session, signalling intent through router state rather than the URL,
since 0025 reserves the URL for the Session id itself; it lives in `nav.tsx` beside `SessionsLink`
because both Reflection pages render it and neither page should import a control out of the other.

**Reflection's and Digest's prompts stop instructing a length.** Reflection's answering prompt and
its fallback prompt both dropped their "in a few sentences of plain prose" / "briefly describe"
clauses, so an Answer's length now follows what its Grounding actually supports rather than a fixed
cap regardless of it. The Digest prompt's self-contradiction — "Write a short piece of prose" in
the same paragraph as "no length target to hit" — is resolved by deleting every sentence about
length and replacing the opening instruction with "Summarise": ADR 0027 already intended a heavy
month to read as a heavy month, and a model resolves a contradiction in favour of the shorter,
first-read instruction, which is why a heavy month had been reading as a paragraph. No `max_tokens`
is added on either path — `llm.rs` records that the configured chat endpoint accepts only `model`,
`messages` and `stream`.


**The send chord branches in a shared module, and this deviates from ADR 0005 deliberately.**
Enter no longer Sends: it inserts a newline, and Sending is a chord that differs by target —
Android has none (its Send button is the only way), the macOS build takes Cmd strictly because it
is always macOS, and the web build accepts either Cmd or Ctrl because one bundle runs on every OS
and a reader pressing the "wrong" modifier still Sending is the failure nobody notices, where an
OS probe that misfires is one that gets filed.

That rule lives in `apps/web/src/lib/submit-chord.ts`, which reads `import.meta.env.MODE` — not in
a `src/platform/submit-chord.<target>.ts` seam resolved by Vite alias, which is what 0005's
Decision prescribes and whose *Alternatives considered* rejects the shape used here in as many
words. The trade was made explicitly, with 0005's own objection in hand:

- 0005's objection is that a runtime branch ships every target's code in every build and "invites
  the wrong signals to silently apply on the wrong platform." The first half holds here and is
  accepted. The second does not: `MODE` is fixed at build time, so a build cannot take another
  target's branch — unlike the `navigator`-sniffing 0005 was actually arguing against.
- What 0005's seam exists to isolate is *machinery*: a SQLite driver, a file-save implementation,
  service-worker registration — modules with imports and lifecycles that genuinely must not be
  linked into the wrong bundle. This is a three-branch predicate over a keyboard event, with no
  imports of its own.
- The predicate takes its mode as an ordinary parameter defaulting to `import.meta.env.MODE`,
  which is what makes every branch testable without stubbing the environment. A seam file per
  target would have made the Android branch unreachable from the test build, where `MODE` is
  `"test"` and matches no target.

The cost is real and recorded rather than argued away: this is now a second place a reader must
look to answer "what differs by platform", and if a future difference needs real machinery rather
than a predicate, it belongs in 0005's seam, not beside this.

**The chord is deliberately not shown, which reverses one of #76's own acceptance criteria.** #76
asked that "the send chord is visible in the UI on desktop targets", on the reasoning that a chord
nobody can see is a chord nobody uses. `d434661` shipped exactly that: a `submitHint()` in
`submit-chord.ts`, rendered under both the Composer and the Question composer. `9c204c2` then took
all of it out — the helper, both renders, and the tests, which now assert the hint is *absent*.

That was a decision made after living with the hint, not a regression, and it is recorded here
because the ticket and the code otherwise contradict each other: a reader who finds
`submit-chord.ts` with no `submitHint()` in it, holding #76's checklist, would reasonably conclude
the work was left half-done. It was not. What survives is the criterion's mechanism without its
affordance — Enter inserts a newline everywhere, the chord sends on desktop, the Send button sends
on every target, and nothing in the interface says so. Discoverability now rests entirely on the
Send button, which is the only path Android ever had.

## Alternatives considered

- **Redirecting `/history` to `/` instead of deleting the route outright.** Rejected: a redirect
  would have kept a URL alive that no longer names a distinct destination, inviting a future reader
  to wonder what it's for. Deleting it outright and leaving no redirect makes a stale link to
  `/history` fail honestly rather than land somewhere it never asked for.
- **Keeping Settings as an app-bar gear and finding a fourth nav destination some other way.**
  Rejected: History's deletion left a genuine slot in a four-destination nav that already sat
  inside Material 3's three-to-five bound (ADR 0018's own citation), and Settings had already
  earned peer status by being the *only* affordance for reaching it once the app-bar gear was
  gone — a utility that is the sole way in stops being distinguishable from a destination.
- **A per-row `DropdownMenu` (right-click or a kebab button) instead of plain buttons and a
  sheet.** Rejected: any Radix menu root, regardless of trigger, carries the same
  one-document-listener-per-mount cost that was the dominant navigation cost being removed. Plain
  `<button>`s and one shared sheet cost nothing beyond DOM nodes already needed to show them.
- **Gating the hover/touch split by build target (web vs. Android vs. macOS) rather than by
  `(hover: hover)`.** Rejected: a build target says nothing about whether the specific device
  running it has a mouse — a touchscreen Windows laptop and a phone can both run the "web" build,
  and the real question is whether the device can hover a pointer, not which bundle it's running.
- **Disqualifying a tap only by press duration, without the "text is currently selected" check.**
  Considered insufficient on its own: a drag-select can end well under 400ms on a short word, so
  duration alone would still have let a fast selection's release be read as a tap; checking
  `window.getSelection()?.isCollapsed` catches that case duration cannot.
- **Widening `EntryStore` with a second, export-specific read shape instead of an optional page
  argument on `list()`.** Rejected on the same grounds ADR 0016 already used against it: `list()`
  already returns every Entry when called with nothing, and a second read shape would touch both
  store implementations and the contract suite for no gain a default argument doesn't already give.
- **`maxPages` on the infinite query, to bound how many loaded pages a refresh touches.** Rejected:
  it evicts from the newest end when an older page is fetched, which is backwards for a reader who
  scrolled back specifically to keep reading further into History — the newest page is the one that
  must never be evicted.
- **Resolving Grounding by widening the array scan's window instead of adding `EntryStore.getMany`.**
  Not seriously entertained: the whole point of paging was to stop reading and rendering every
  Entry, and any fix that widened the scanned window back out would have quietly undone that.
- **Keeping the Undo toast alongside the new confirmation dialog, rather than replacing it.**
  Rejected: with Delete already gated behind a real confirmation step, a second safety net past that
  point is redundant friction, not an added protection — the ten-second window Undo bought no longer
  answers a question the dialog hasn't already asked.
- **A local table for a Conversation's content, which is what ADR 0025 itself once considered and
  rejected for the identical reason ADR 0020 originally deferred to.** Not reopened here: 0025's
  reasoning against a local table (it buys reload-survival, not cross-Device reach, and would have
  made a Conversation the first mutable non-Entry record this codebase stores) still holds. What
  changed is narrower — remembering *which* Session to resolve a bare `/reflect` to, not storing
  *what* a Session contains.
- **A token cap (`max_tokens`) instead of deleting the length instructions from the prompts.**
  Rejected: the configured chat endpoint accepts only `model`, `messages` and `stream` (`llm.rs`),
  so a cap isn't available as a parameter; and a cap would have re-imposed the same "briefer than
  the Grounding supports" ceiling this ticket exists to remove, just enforced mechanically instead
  of by instruction.

## Consequences

**The e2e suite's flakiness under parallel workers was a symptom of this ADR's own virtualization,
and is fixed** (issue #86, closed). The fallback that renders estimate-positioned rows when the
virtualizer reports an empty range keyed on the *symptom* — `getVirtualItems()` being empty —
rather than the cause, and that condition is true in a real browser on first paint, not only under
jsdom. Every page load in the suite therefore rendered the entire History before measurement
settled, which is exactly the cost this ADR exists to remove. Single-worker there was enough CPU to
absorb it; under parallel workers it crossed assertion timeouts, which is why every failure was a
timeout or a not-found rather than a wrong assertion, and why the failing set moved between runs.
The fallback now keys on there being no usable scroll element and is capped regardless. Measured in
a real browser, first paint peaks at 29 rows; three consecutive full runs at the default worker
count give 39/39 in about 1.1 minutes each, against `main`'s 46/46 in 1.9.

**The day pill's height is load-bearing.** It sits in flow above the spacer `contentAboveList` is
measured from, so any variation in its height shifts every absolutely-positioned row below it — and
on a History longer than the viewport `spacerHeight` is floored at 0 and absorbs nothing. Mounting
it unconditionally was not sufficient on its own, because the label text is withheld while hidden
(so it cannot duplicate the inline separator's text for `getByText` and assistive tech) and an empty
inline span collapses to a different height than one containing text — still worth 16px of jump per
toggle when measured. Its height is now fixed outright. Anything later added inside that wrapper
must not be allowed to change its height.

**Reflection had the identical seeded-at-0 reflow defect `composer-page.tsx`'s `sendSignal` had,
and no longer does** (issue #85). When this was written, `reflection-page.tsx`'s `askSignal` was
seeded with `useState(0)`, which defeated `use-pinned-scroll.ts`'s `forceToNewest === undefined`
mount guard the same way `sendSignal` once did, forcing a second, redundant `jumpToNewest()`
layout pass on every mount of Reflect on top of the `watch` effect's own one. It was left unfixed
here because `reflection-page.tsx` was outside the file ownership of the ticket (#81) that fixed
the Composer's copy of the same bug — and it stayed unfixed only until `871b00b`, which rewrote
that page for #96 and took the fix with it.

The paragraph is amended rather than deleted because the trap it names outlives the bug. The fix
is to seed `undefined` and increment with `(count ?? 0) + 1`, never a plain `count + 1`:
`undefined + 1` is `NaN`, `Object.is(NaN, NaN)` is `true`, and React's dependency check is
`Object.is` — so a plain increment would leave the *second* ask looking unchanged and silently
stop scrolling. Any future signal of this shape has the same two ways to be wrong.

**The sol/terra/luna chat-model comparison issue #77's own acceptance criteria calls for has not
been run.** The ticket's prompt changes shipped — Reflection's and Digest's length clauses are
gone, as recorded above — but comparing the three configured models on a fixed day Digest, a fixed
month Digest and one grounded Question, before and after the prompt change, could not be completed
because the local LLM endpoints were down at verification time. The configured chat model is
unchanged, as the ticket also required, but the comparison itself remains open.

**`composer-page.tsx` carries a vestigial effect.** Its `location.state.editEntryId` read exists
only because the deleted `/history` page's Edit action used to navigate here with an id in router
state, having no Composer of its own to edit in. Issue #75 deleted that page outright rather than
redirecting it, so nothing in the app sets `editEntryId` any more — the effect's `undefined` branch
always returns early, inert rather than broken. It was left in place and documented rather than
removed unasked, as a decision this batch of tickets deliberately did not fold in silently; it
remains a candidate for a small dedicated follow-up.

**History's redundancy, which ADR 0018 accepted knowingly when it kept `/history` addressable
alongside `/`, is gone along with the route that carried it** — there is now exactly one consumer
of the `History` component (`composer-page.tsx`), which is what several of this batch's other
changes (paging, virtualization, the shared action sheet and dialog) each got to assume without
raising the question of a second consumer's own requirements.

**Grounding's async resolution introduces a rendering state that did not exist before paging**: a
turn whose Grounding ids haven't resolved yet now renders a neutral loading placeholder rather than
either the Entry or the "hasn't reached this Device yet" message. This is a strictly more honest
state than what preceded it, but it is a new one, and any future change to `GroundingDisclosure`
needs to keep the three states — resolved, loading, genuinely absent — visually distinct.
