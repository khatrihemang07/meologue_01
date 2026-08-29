# 0036: The shell is a chat list, and History is a chat thread

## Status

Accepted.

Supersedes [0018](0018-two-nav-destinations-across-three-routes-with-settings-as-an-app-bar-action.md)'s
navigation technique outright. That ADR argued for exactly one `<nav>` landmark, repositioned by
CSS between a bottom bar below `md` and a left rail at `md` and up, specifically so no page ever
presented two navigation landmarks to a screen reader. The `<nav>` is deleted rather than
repositioned: there is no navigation region present on every page to be one landmark or two,
because the list is a screen the reader leaves rather than chrome that stays mounted beside
whatever is showing. What 0018 got for free is paid for explicitly here — see *The list is a
screen, not chrome* below. 0018's bottom-docked Composer, its oldest-first reading order and its
shared day-separator grouping all stand unchanged and are still load-bearing.

Supersedes [0030](0030-the-shell-gets-a-root-screen.md) in its strongest form. 0030 is titled "the
shell gets a root screen" and its Decision never built one: what it actually decided was which
four destinations the persistent nav carried, and `/` stayed the Composer. This is that root
screen. 0030's membership decision survives intact — the four destinations are still Composer,
Reflect, Digest and Settings — and so does everything it decided about `EntryStoreLayout`, the
Sync-off gates and Settings being a sibling route outside the store.

Composes with [0019](0019-a-proportional-reading-column-and-back-returns-to-settings.md) rather
than replacing it. The proportional reading column still governs every destination's content; what
changes is what it is proportional *to*, which at the wide breakpoint is now the open pane rather
than the window. 0019's own "Back returns to Settings" clause was already retired by 0030 and is
not revived here.

Partially supersedes [0020](0020-reflection-is-a-third-navigation-destination.md). Its "Reflection
joins the persistent Nav" clause cannot hold: a destination cannot join a navigation element that
no longer exists. Reflection is one of the four rows on the root screen instead, which is the same
standing by a different mechanism. Everything else 0020 decided — the `/reflect` route inside
`EntryStoreLayout`, the Sync-off gate, Sessions staying one level down rather than becoming a
peer — is untouched.

## Context

The app shell had been, since 0018, a persistent navigation element plus one page. Four
destinations sat in a bar across the bottom of a phone and a rail down the left of a laptop, and
`/` was the Composer. The reader was never anywhere else: every destination was one tap away at
all times, and there was no screen whose job was to say what the destinations were.

Three things were wrong with it, and they were not the same kind of thing.

**The nav spent a permanent slice of the screen on a question already answered.** On a phone the
bottom bar cost around 56px of every page, forever, to tell a reader who had been using the app
for a month what its four destinations were. On a laptop the rail cost 80px of width for the same
reason. Neither was reclaimable, because the whole argument for a persistent nav is that it is
persistent.

**The Composer was a list of rows, and the thing it is is a conversation.** An Entry is something
the user wrote, in their own words, one after another, in time order. That is what a chat thread
is, and the app rendered it as a bordered list with a timestamp column — a shape that says
"records" where the content says "the things I said today". #49's own variant round had already
chosen a full-width row over a bubble, and it was right at the time, because the row was competing
against a bubble with a tail, a saturated fill and a 70% max width. It was not competing against a
flat bubble with a near-background fill.

**The touch model spent the tap.** Tapping a row opened its action sheet. That is unusual in a
chat interface, and it takes the one gesture that should be free — placing a cursor, dismissing a
selection — and gives it to something a reader wants once in a hundred rows.

A prototype (`ui/chat-redesign`, retired at tags `proto-v1` and `proto-v2`) explored this shape as
a standalone HTML/CSS/JS harness. It answered several questions and got three of them wrong; those
three are named as reversals below. The prototype's own ADR 0036 cited its files line by line and
every one of those citations is now dangling, which is why this document is written fresh against
`apps/web/src` rather than amended.

## Decision

### The root screen is a chat list of four destinations

`/` is a list of four rows — Composer, Reflect, Digest, Settings — each with an icon, a label and
a line of summary (`apps/web/src/components/chat-list.tsx`). Opening a row is a full-bleed push
onto that destination; the Composer moved to `/composer`. `apps/web/src/components/back-to-chats.tsx`
is the way out.

The rows are exactly what the persistent nav's four destinations were. Nothing about the app's
information architecture changed; what changed is that the answer to "where can I go" now has a
screen of its own instead of a permanent strip on every other screen.

### The list is a screen, not chrome

The persistent `<nav>` is deleted, not repositioned. 0018's single-landmark technique existed to
solve a problem this shape does not have, and it is worth being precise about which problem: with
navigation present on every page, a bottom bar and a left rail rendered as two separate elements
would have been two `banner`/`navigation` landmarks in one document, and a screen reader would
announce both. One element repositioned by CSS was the right answer to that.

Here there is no navigation on a destination at all. What 0018's `<nav>` gave for free is paid for
explicitly:

- Every row is a real `<a href>`, so a middle-click, a long-press "open in new tab" and a
  bookmark all work.
- `NavLink` puts `aria-current="page"` on the row whose destination is open, which is what makes
  the pinned list at the wide breakpoint say which pane is which.
- `chat-list.tsx` carries a `<nav aria-label="Chats">` scoped to the list itself, so the landmark
  exists exactly where navigation exists and leaves the accessibility tree with the pane.

### At 900px and up, the list pins beside whatever is open

`apps/web/src/pages/chat-shell-layout.tsx` owns the window: its height, the keyboard custom
properties, and the two-pane split. `Shell` (`apps/web/src/components/shell.tsx`) stopped being the
window and became a pane — an app bar, a scroll region and a docked Composer, and nothing above
that. The split is what lets the list sit beside a destination without either one trying to be the
window at the same time.

The divider between them is draggable and persisted per Device
(`apps/web/src/components/pane-divider.tsx`, `listWidth` in
`apps/web/src/lib/settings.ts`) — on every platform, Android included, because a tablet in
landscape is as much a two-pane window as a laptop is. Its width is clamped in CSS rather than in
JS, so a preference set on a laptop and met on a smaller window is corrected on render instead of
being silently rewritten in storage.

Two defects the split exposed, both invisible before it, are recorded because they are the shape
of thing this split will keep producing:

- The list pane's header and a destination's app bar were two `<header>` elements at the top level
  of one document — two `banner` landmarks, which is precisely the duplicate-landmark defect
  0018's single `<nav>` existed to avoid, reappearing on the other axis. The destination's bar is
  the page's banner; the list's heading is a `<div>` with an `<h1>` in it.
- Both panes said "meologue" in their app bar, which was right while the Composer was the root
  screen and says nothing once they are side by side.

### A thread is a thread: bubbles, a side, and a clock time that shares the last line

`apps/web/src/components/entry-bubble.tsx` holds `Bubble`, the shape, with no idea what is inside
it. Composer's Entries render through it, and so do Reflect's Question and Answer. None of the
three is the same *thing* — CONTEXT.md is explicit that a Question is not an Entry and an Answer
is not an Entry — but they are the same shape in a thread, and two hand-maintained copies of that
shape is how two destinations start disagreeing about what "outgoing" looks like.

The treatment is #49's F — flat, near-background fill, no tail — plus the one thing F dropped: a
side. A ~12% inset on the opposite edge costs a little width and buys the strongest "who said
what" cue there is without borrowing a tail's shape. A run from one side groups tightly; a change
of side is the boundary worth spacing.

The clock time is a right float rendered after the body, which gives it WhatsApp's own behaviour
for free: placed on the current line when there is room, pushed to the next when there is not. The
body is inline rather than `EntryBody`'s `<p>` for exactly this reason — a float placed after a
block box has no line of its own to join. The first attempt at this passed every test and was
wrong on screen; only a screenshot caught it.

`entry-row.tsx` survives as the *list* shape, and is what Reflection's Grounding disclosure
renders. That file's own doc comment used to argue History and Grounding must never drift
visually, and it was right while both were lists. Once one is a thread and the other is a list,
holding them identical stops being honesty and becomes a constraint neither wants. `EntryBody`'s
words are still shared, so the words themselves cannot drift.

### The thread stays at the bottom when the box around it changes

The soft keyboard opening, a Composer growing as a draft wraps, and a rotation all shrink the
scroll region without adding an Entry to it — and a browser preserves `scrollTop` across all
three, which is precisely wrong at the bottom of a thread. One `ResizeObserver` in
`apps/web/src/hooks/use-pinned-scroll.ts` answers all three without needing to know which
happened, and re-pins only a reader who was already pinned.

`apps/web/index.html`'s viewport declares `viewport-fit=cover` and
`interactive-widget=resizes-content`; `apps/web/src/hooks/use-keyboard-inset.ts` is what makes one
code path correct on both engines, because WKWebView ignores `interactive-widget` outright. Both
are recorded in full in the commit for #124 rather than restated here.

Jump-to-newest is a floating circle anchored to the scroll region, not a band across the viewport.
A band was argued against an overlay hanging at the *viewport's* edge, which covered whatever line
sat under it; anchored to the scroll region instead, a circle covers a corner rather than a line
and costs none of the thread height a band claimed permanently.

### Swipe left opens an Entry's actions; a tap does nothing

The touch gesture is a leftward swipe. The bubble translates up to 48px with rubber-band
resistance, then springs back to zero on release while the action sheet slides up over it.
`apps/web/src/lib/swipe-recognizer.ts` is the pure recogniser — thresholds, axis lock, the
long-press window, the rubber band and the release velocity, and nothing about the DOM.
`apps/web/src/hooks/use-swipe-actions.ts` is what a swipe *means*: one recogniser per thread,
the transform, and the spring back.

The disambiguation numbers are the prototype's, reused rather than re-derived: 12px of horizontal
travel to confirm, 12px of vertical travel to bail to native scroll, a 400ms window after which
the gesture is abandoned to the platform's own long-press, a 0.55 rubber-band coefficient, and a
0.5 px/ms flick velocity that opens regardless of distance. They were tuned against a finger on
real hardware, with the platform's own long-press and text selection competing for the same
gesture, and a synthesised pointer sequence cannot reproduce that competition.

Two constraints govern everything about it:

- **The bubble's width never changes.** It moves by `transform`, which is a paint-time operation,
  so its width and its line breaks are arithmetically incapable of changing while it does.
- **Long-press is left alone.** It is what raises the platform's native selection handles and
  system Copy toolbar. The recogniser checks for a live selection at every stage of the drag, not
  only at the start, and bails out of the gesture whenever one appears.

The sheet gains **Copy** alongside Edit and Delete. Copy was withheld from the touch model only
because the prototype's revealed strip had no room for a third button; a sheet has room. Delete
still goes through the shared confirm dialog. Copy reports both outcomes and reports them
differently (`apps/web/src/lib/clipboard.ts`), because a clipboard a WebView refused must not look
identical to one that succeeded — the reader would paste stale text somewhere else and blame that.

A mouse is untouched: hover buttons and right-click, exactly as before. The recogniser ignores
`pointerType === "mouse"` outright, which is what keeps dragging across an Entry to select it
working — the thing issue #78 restored by deleting the per-row context menu.

### Digest fills the page

Three cards clamped to two lines each while more than half the screen sat empty below them is not
a reading view. The three Periods render at their natural height whenever they fit one screen, and
only when they overflow does anything clamp — each proportionally to what it actually needs, and
always to a whole number of lines. `apps/web/src/lib/proportional-clamp.ts` holds the allocation;
`apps/web/src/pages/digest-page.tsx` measures the line height and the available space rather than
assuming either.

A budget in lines rather than pixels is the point: a pixel budget cuts wherever it lands, which is
what produced the defect this replaces — an ellipsis at the end of the second line with a sliver
of a third showing through beneath it. A clamped card carries an explicit way to read the rest;
the reader route survives for deep-linking and for prose too long to expand in place.

### Settings gains Accent and text size, and one spacing shape

Accent and text size join theme as device-local settings, persisted the same way and stored per
Device (`apps/web/src/lib/settings.ts`). They are view mechanics, so they do not enter the
glossary — the same category 0019 put the reading column in.

The ids live in `settings.ts` and the five colours and three scales live in
`apps/web/src/index.css` under `[data-accent]` and `[data-text-size]`, with
`apps/web/src/lib/theme.ts` writing only the attribute. That split is what lets `index.html`'s
pre-paint script apply a stored Accent and text size without carrying a second copy of five
colours it would then have to be kept in step with — the same paint-time head start the theme
already had.

Text size multiplies the words the reader wrote and nothing else. The clock time, the sync tick
and the day label carry their own fixed sizes and never read `--entry-text-scale`, because scaling
those too is just making the screen bigger, which the OS already does better. Reflect's Question
and Answer deliberately do not scale either: a Question is the reader's own words and an Answer is
not, and scaling one without the other would put two sizes of prose in one thread.

Every section shares one spacing shape (`SettingsSection` in
`apps/web/src/pages/settings-page.tsx`), every control clears 44px, and the five Accent swatches
lay out as an even five-column grid — a wrapping row breaks after four on a phone and leaves the
fifth orphaned on a line of its own.

## Three reversals of what the prototype settled

The prototype argued these the other way and reached a different answer. Saying so is the point:
a future reader should be able to tell a decision that was made once from one that was made twice.

**Swipe-to-sheet over swipe-buttons.** The prototype built swipe-buttons — Edit and Delete
revealed in a strip under the row — and explicitly rejected swipe-to-sheet. Keeping the actions
*inside* the row is what forced the bubble to narrow its max width by the strip's width once
latched, which reflowed the text: a one-line Entry became two the instant the row opened. That
narrowing was itself a fix for something worse (the shortest bubble going blank), which is the
tell — the cost was structural, not a bug in the implementation. A sheet has no such cost, the app
already shipped a sheet for exactly these actions, and a sheet has room for the third one.

**Side asymmetry over pure treatment F.** F's argument — width should serve the words, not a
container shape — survives, and the fill is still F's. What does not survive is telling a Question
and its Answer apart by tint alone at full width on both sides: on Reflect, with real Question and
Answer prose, they were genuinely hard to scan apart. The ~12% inset is the smallest thing that
fixes it without reintroducing a tail. The Accent setting is the other half of the same fix: an
outgoing bubble and an incoming one were `bg-primary/10` against `bg-muted`, which in the light
theme are both near-grey.

**Digest fills the page.** The prototype kept the two-line clamp and treated the empty space below
it as unremarkable. It is not: a page whose entire job is to show what the Server wrote, showing
two lines of it above half a screen of nothing, is a reading view that does not let you read.

## Deliberately out of scope

Recorded so a future reader does not mistake absence for oversight.

**No unread badge.** No read or seen state exists on an Entry, a Digest or a Session, anywhere in
the model or on the wire. A chat list invites a count on each row, and inventing the state to fill
one is a much larger decision than a shell redesign should make by accident — it would mean
deciding what "read" means for a Digest nobody asked for, and whether it is per Device or Synced.
The rows carry a summary line instead, which says what a destination is rather than how much of it
is new.

**No cross-destination search.** History has Search ([0014](0014-entry-search-hand-maintained-fts5-index.md),
[0035](0035-entry-full-text-search-on-the-server.md)) and Sessions has its own; neither ADR
designed a search across Entries, Sessions and Digests together, and this one does not either. A
search field on the root screen would be an inert control implying a capability that does not
exist. The gap is named here in words rather than represented by a control.

## Alternatives considered

**Keep the persistent nav and only change the thread.** This was tried first and is what the app
shipped between 0030 and here. It fixes the second problem and neither of the other two, and it
leaves the strongest argument against the nav untouched: the destinations are four, they are
stable, and a reader learns them in a day.

**A hamburger drawer instead of a root screen.** A drawer is chrome again — mounted on every page,
one landmark to get right, and reachable only through a control that itself costs a corner of the
app bar. It also has no wide-breakpoint story better than "the same drawer, but pinned", which is
what the two-pane split already is, without the drawer.

**`/` redirects to `/composer`, with the list at `/chats`.** This keeps every existing bookmark
working and costs one redirect. It was rejected because the root screen is the thing the reader
should land on cold, and a redirect off `/` means the app's own front door is a page nobody sees.
Existing bookmarks to `/` land on the list, which is a screen, not an error.

**Bubble with a tail.** #49 already rejected it and nothing here changes that argument: a tail
buys the same "who said what" cue the side inset buys, at the cost of a shape that reads as a
messaging app rather than a journal, and it forces a max width that fights 0019's reading column.

**A single clamp height for all three Digest cards.** Simpler to implement and simpler to explain,
and wrong: a Period with three lines of prose and one with thirty do not deserve the same height,
and equalising them wastes the short one's space to no benefit.

**A slider for text size, and a colour picker for Accent.** Both offer more choice than anyone
wants and more ways to reach a result that looks broken. Three named sizes and five named swatches
are a decision a reader can make in a second, and they let the values live in CSS rather than in
storage.

## Consequences

The persistent nav is gone, and with it the argument in 0018 that produced it. Any future
navigation element has to make its own case rather than inheriting one.

Reaching a destination costs one more tap on a phone than it did. That is the price of the screen
the nav's space bought back, and it is why the root screen is a *list of chats* — a shape a reader
already knows how to use — rather than a menu.

There are now two shapes for an Entry: a bubble in a thread and a row in a list. They can drift,
and the only thing structurally preventing it is that they share `EntryBody`'s words. That is
deliberate, and it is the thing to check first if Grounding ever starts looking wrong.

The wide breakpoint has a two-pane layout with a draggable divider, which is a new class of
defect: anything that assumed a single pane, a single app bar or a single banner landmark is now
wrong at 900px and up, and was right below it. Two such defects were found while building this,
both invisible in a phone-sized window.

Digest and the thread both now measure real layout to decide what to render. Both degrade to
"render everything, clamp nothing" when they cannot measure — under jsdom, and in a real browser's
first frames before its first `ResizeObserver` callback lands — which is the benign direction, but
it does mean a unit test cannot see either behaviour. The measurements are covered by the
Playwright suite instead.

Two of this shell's claims are only checkable on a device, and both were checked there rather than
argued. On Android, a real 900ms press on a bubble still raises the platform's own selection
handles and its Copy / Share / Select all toolbar, and a held swipe moves the bubble's x while its
width and height stay at 307.07 x 110.28 to the pixel. In the signed macOS Sandbox bundle, the
Accent renders the hue it should on a second `color-mix` implementation, and Copy reaches the
system clipboard. Neither could have been established from Chromium, and the first could not have
been established from a synthesised pointer sequence at all — a synthesised long-press does not
make the platform compete for the gesture, which is the only thing the 400ms window exists to
lose to.

One thing is verified as behaviour and unverified as mechanism, and is worth naming so nobody
later reads more into the code than is there: Copy works in the macOS bundle, but whether it went
through `navigator.clipboard` or the `execCommand` fallback is unknown, because a signed release
build exposes no Web Inspector. `clipboard.ts` carries the same caveat at the point it matters.
