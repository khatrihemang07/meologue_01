# 0087: Day navigation has two doors, and the corner one never leaves the screen

## Status

Accepted. Builds on [0079](0079-back-is-for-screens-not-for-state-within-one.md), whose
distinction between a navigation a reader would name "going somewhere else" and one that merely
adjusts what a Destination is showing is the rule the corner control's history-entry question
answers by. Amends the design shipped in commit `cda692c` for issue #354 without retiring the
feature that commit shipped — the bottom-left circle stays; three specifics about when it shows
and what it targets are wrong and this ADR reverses them.

## Context

History now has two ways to move by day, and nobody had written down that they are different
controls answering different questions.

The in-thread day markers — the sticky day pill (`apps/web/src/components/history.tsx:1369-1433`)
and the inline day separator (`apps/web/src/components/history.tsx:1466-1501`) — open
`DatePickerSheet` and **navigate**: `handleDateConfirm` (`history.tsx:903-905`) does
`navigate(\`/composer?d=${dayKey}\`)`, a Reference seek, which pushes a history entry.

The `?d=` param itself is a transient *command*, not a record — worth stating plainly, because
the obvious reading of that `navigate` call is wrong. `settleSeek`
(`apps/web/src/pages/composer-page.tsx:206-216`) deletes both seek params with
`{ replace: true }` the instant History reports the target reached, so the param is obeyed and
erased within a frame or two and the reader is left on a plain `/composer`. Driving the picker in
a real browser and polling the address bar for 1.5s after each confirm never catches it. What
survives the round trip is the history entry, not the URL. Arbitrary date, deliberate act,
Back-able.

The bottom-left corner control scrolls the virtualizer **interiorly**: `registerScrollToDay` sets
`dayJumpTarget` (`history.tsx:1137-1149`), and a second effect resolves that target against
`flatItems` and calls `virtualizer.scrollToIndex(targetIndex, { align: "start" })`
(`history.tsx:1164-1177`), touching nothing else. One nearby day, one tap.

The shape shipped in `cda692c` was wrong on three counts, and all three came from treating the
corner control as a scrolled-up *mode* of the Composer rather than a permanent part of it:

- **(a)** It anchored on **today** and published a `hasTodaySeparator` flag. `flattenGroups` only
  ever emits a day separator for a day that actually has an Entry, so on a morning nothing had
  been written on yet, History emitted no separator for today, there was nothing to land on, and
  the control vanished — on exactly the morning a reader most wants a way back to what they were
  writing.
- **(b)** It hid itself whenever the reader was parked at the newest end (gated on the same
  `awayFromNewest` flag the jump-to-newest circle uses), which is precisely when a reader wants
  the top of the day they are already reading.
- **(c)** Its label rode a `min-[900px]` breakpoint borrowed from `WIDE_LAYOUT_QUERY`
  (`apps/web/src/hooks/use-wide-layout.ts:8`), a value that answers a different question — "is
  there room for two panes beside each other" — with a consequence nobody noticed until now: the
  desktop app's own default 800×600 window (`apps/macos/tauri.conf.json:9-17`) never showed the
  label at all, at any width a reader would actually open that window to.

A fourth defect sits beside those three, in the same spirit: the label was an `aria-hidden`
`<span>` sitting *beside* the Button as a sibling, not inside it. On a wide window the widest and
most button-looking part of the control — the pill with the day's name written in it — did
nothing when clicked, and the focus ring landed on a bare circle next to text a keyboard user
could never reach.

## Decision

**Day navigation has two doors. The in-thread day markers pick a date and navigate; the corner
control scrolls interiorly and never touches the URL. A control that only moves the viewport is
always present, and it anchors on the newest day that holds Entries — not on today.**

### The corner control never enters the URL

This is the purest case ADR 0079's rule has produced so far: no param, no history entry, not even
a `replace`. `dayJumpTarget` is held as component state (`history.tsx:1137`) precisely so it
cannot ride the same `?d=` param the date-Reference `seek` prop reads — where a reader had
scrolled to is not a place they went. A reload lands wherever pinned-scroll puts the reader, and
that is correct: the corner control's job ends the instant the scroll finishes, and it leaves
nothing behind for a reload, a share, or a Back press to reckon with.

Note what this does and does not distinguish the two doors by. Both end with a clean `/composer`
in the address bar, because the picker's param is cleared behind it; the URL alone cannot tell
you which one a reader used. The difference that survives is the **history entry**: the picker
pushes one, so Back returns to wherever the reader was before they picked a date, while the
corner control pushes nothing, so Back leaves the Composer entirely rather than replaying a
scroll. Verified in a browser: `history.length` is unchanged across corner-control clicks, and
`history.back()` from a corner jump lands on the previous Destination, not on the previous scroll
position.

### It anchors on the day the most recently inserted Entry belongs to

*"Back to where I was writing" is a fact about the journal, not about the calendar.* At 08:00 with
nothing written today, "today" is not a destination a reader has any reason to visit; the last day
they wrote on is. This is implemented in `history.tsx` as:

```
const newestEntryDayKey = useMemo(
  () => groups.findLast((group) => group.dayKey !== null)?.dayKey ?? null,
  [groups],
);
```

Both halves of that expression are load-bearing on their own terms. `findLast`, because `groups`
is oldest-first: composer-page.tsx hands History `orderedEntries`, which is `shown.slice().reverse()`
in `apps/web/src/hooks/use-history-search.ts:104` — `list()` itself returns newest-first, and the
thread reads downward. The same fact is why jump-to-newest targets `flatItems.length - 1`
(`history.tsx:1123`) rather than index 0; both controls are reading the same oldest-first array
from opposite ends for the same reason.

The `dayKey !== null` predicate, rather than the simpler `groups.at(-1)`, is there because an
Entry whose `createdAt` does not parse gets its own trailing, null-keyed group — `groupByDay`
(`history.tsx:268-279`) deliberately refuses to fold an unparseable Entry into a neighbouring day
it does not actually belong to — and `flattenGroups` emits no separator for a group with a `null`
day. Anchoring on that group would hand Shell a day boundary that does not exist anywhere in
`flatItems`. The jump would then fall into the same `onSeekNeedsOlder` retry a genuine date-seek
uses when a target hasn't been paged in yet, and keep paging the whole journal in looking for a
separator that is never coming.

The visible label — "Today", "Yesterday", or a plain date, via `formatDaySeparator` — is a
*consequence* of the anchor, not a second decision. `dayJumpAriaLabel` and `formatDaySeparator`
both still take `todayKey` as an argument to choose the word; they no longer decide whether the
control exists.

### Always present, one element, one target

The only condition that hides the corner control is `newestEntryDayKey === null` — a journal
holding no parseable Entry anywhere, i.e. no destination at all to offer. Every other journal,
including one where today itself is empty, gets a real anchor.

The label moves inside the Button rather than beside it, and the breakpoint drops from the
borrowed `min-[900px]` to Tailwind's own `sm` (640px), so the accessible name and the visible name
belong to one control at every width, and the 800px desktop window falls on the correct side of
the line.

The `size="icon"` trap is worth stating concretely, because it is not obvious from the diff alone:
`size="icon"` sets only `size-8` (`apps/web/src/components/ui/button.tsx:33`), and
tailwind-merge's conflict map is one-directional — `size: ['w', 'h']` means a later `size-*` class
clears an earlier `w-*`/`h-*`, but a later `w-10` or `sm:w-auto` does *not* clear an earlier
`size-8`. Both classes would survive onto the rendered element, and whichever one Tailwind happened
to emit last would win — a coin flip this component does not control. Overriding the cva
*default* size instead of passing `size="icon"` keeps every class the control sets (`h-10` for
`h-8`, `gap-2` for `gap-1.5`, `px-0` for `px-2.5`, `rounded-full` for `rounded-lg`) in the same
merge group as the base class it replaces, so resolution is deterministic — and `w-10` versus
`sm:w-auto` becomes an ordinary same-utility variant pair, exactly the case tailwind-merge's
ordering guarantee does hold for.

## Alternatives considered

- **Keep the `awayFromNewest` gate, matching the jump-to-newest circle.** Rejected: the two
  controls are symmetric in position only. The right-hand circle has nothing left to say once a
  reader is already at the newest end; the left-hand one does — the top of today is somewhere a
  reader cannot already be while reading today's newest Entry. Gating it on scroll also made it
  flicker in and out of the corner on every crossing of `NEWEST_THRESHOLD_PX`.
- **Keep anchoring on today and hide the control when today is empty (the shipped behaviour).**
  Rejected: this removes the control exactly when its destination is most useful, and makes its
  presence depend on the clock rather than on the journal.
- **Let the corner control write `?d=` so a jump is shareable and survives reload.** Rejected: ADR
  0079 already answers this — the control only adjusts what one screen shows, and does not earn a
  history entry or a URL. It would also mean Android hardware Back walked a reader back through
  every jump before it finally left the Composer, the same failure mode 0079 exists to retire.
- **Make the in-thread day markers jump directly too, so every day label behaves the same way.**
  Rejected: they are the only door to arbitrary-date navigation, and the inline separator already
  *is* the start of its own day, so jumping from it is close to a no-op. Making the two doors
  behave identically would have cost a capability — going anywhere — to buy a consistency nobody
  asked for.
- **Reserve layout space so the pill never covers a row on a phone.** Rejected: a permanent gutter
  costs every reader thread width at every width, to fix a corner overlap that only exists at
  narrow widths. `shell.tsx` already made this same trade once, for the jump-to-newest circle, and
  accepted the overlap rather than the gutter.
- **A third bespoke `min-[…]` query tuned to 800px.** Rejected: another breakpoint to hold in one's
  head, when Tailwind's own `sm` token already sits below every desktop window this app opens.

## Consequences

`HistoryDayJumpState` loses `hasTodaySeparator` and gains `newestEntryDayKey`; `todayKey` stays on
the shape but is demoted to a formatting argument, no longer a target. It is worth recording why
`todayKey` stays published from History rather than recomputed in Shell: `history.tsx` leaves
`todayKey` deliberately un-memoised so it re-derives every render and survives a midnight rollover
mid-session, and the publish effect's dependency array carries that liveness through to Shell. A
Shell-local `entryDayKey(new Date())` would be computed on whatever cadence drives Shell's own
render, which nothing ties to a clock, and could sit stale past midnight — the control saying
"Today" over a separator that has already rolled over to "Yesterday".

Under an active search, the anchor follows what History currently *shows* — `orderedEntries`, the
same array a search narrows — so the anchor becomes the newest day among the search results, not
the newest day in the whole journal. This is intended, not an oversight left unexamined: a reader
scoped to a search has no reason to be handed a destination outside it.

On a phone the circle remains permanently over a corner of the thread. Accepted, with the same
reasoning already applied to the jump-to-newest circle; no layout space is reserved for it.

Any future "take me to X" control built inside a Destination should ask which of the two doors it
is before it is built: if it only moves the viewport, it stays out of the URL and it stays
present regardless of scroll position.

Two tests in `apps/web/src/components/history.test.tsx` were retired by name, because they
asserted the positions this ADR reverses: "shows neither control while pinned to the newest end,
even though today has Entries" and "shows neither control when today has no Entries, however far
the reader has scrolled".
