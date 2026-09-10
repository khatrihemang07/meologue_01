# 0074: A checkbox in History opens its Task

## Status

Accepted. **Supersedes [0043](0043-an-entry-may-carry-structure.md)'s "a checkbox is clickable, and
ticking it splices the stored string," in full** — both the half this ADR retired first (a *bare*
checkbox, no `[[task:id|label]]` mark behind it, spliced `[ ]`/`[x]` straight into the Entry's body
through `toggleTaskAt`, toggle-task.ts) and the half a bare checkbox's own retirement left standing
(a *referenced* checkbox, which kept writing the Task directly — `completeTask`/`uncompleteTask`/
`advanceRecurringTask`, use-tasks.ts — from a click in `entry-row.tsx`'s `TaskReferenceItem`).
Neither shape still ticks anything from History; both now open. **Narrows, but does not repeal,
[0048](0048-a-task-reference-is-a-node-with-a-cached-label.md)'s "ticking writes the Task."** That
rule still governs the one place ticking still happens — Todo's own row, and the Composer's Task
detail overlay reached by `onOpenTask` — it simply has no trigger left inside History any more,
because History no longer offers a control that ticks at all. Extends issue #181's own amendment to
0048, which gave a referenced line's *words* a click-to-open door onto the Task detail overlay
alongside its still-tickable box; this ADR is what happens once that box stops being tickable too —
opening becomes the *only* thing left for either the words or the box to do, so they now do the
identical thing. Depends on [0053](0053-every-checkbox-is-a-task-and-existing-history-is-backfilled.md),
whose "every checkbox is a Task" promise and backfill are what make a single completion surface
possible to promise at all — without 0053, an old bare checkbox would have no Task to route to, and
this ADR could not hold universally rather than only for checklist items written after Promotion
shipped.

## Context

History had two checkbox shapes, and — until this ADR's second half — two different reasons each
one couldn't simply open its Task the way a click on its words already could for one of them. A
checkbox whose whole line is a `[[task:id|label]]` reference has a Task to point at: the mark
itself carries the id (`referencedTaskOf`, inline-markdown.ts), and issue #181 already gave its
cached label a click-to-open door onto the Task's detail view over the Composer (`onOpenTask`,
threaded from `entry-bubble.tsx` through `entry-row.tsx`'s `TaskReferenceItem` to
`composer-page.tsx`'s `openTaskOverlay`). But its *checkbox* still did the older thing 0048
specified: clicking it ticked or un-ticked the Task directly (`completeTask`/`uncompleteTask`,
including the recurring-Task exception through `advanceRecurringTask` plus a one-line
`setTaskMarkerChecked` cache refresh on this one Entry's own marker) — the identical write Todo's
own row performs, reached from a second, competing surface. A *bare* checkbox — one with no
reference behind it — had no Task to point at in the first place: `EntryTaskMarker`
(inline-markdown.ts) is `{ checked, markerFrom, markerTo }`, nothing else, and `Task`'s own type
(packages/core/src/task-types.ts) says so explicitly in its own header comment — "nothing here
records which way it arrived," no back-reference to the Entry that may have minted it. There is no
second index anywhere in the app mapping a checklist line's source offsets to a Task id; the
`[[task:id|label]]` mark *is* the association, full stop. Before 0053's backfill and issue #173's
Promotion (`promoteBareCheckboxes`) finish converting old writing, a bare line still did what 0043
originally specified instead: `entry-prose.tsx`'s `renderListItem` wired its `onChange` straight to
a caller-supplied handler, threaded through `entry-bubble.tsx` into `composer-page.tsx`'s
`handleToggleTask`, which spliced `[ ]` to `[x]` in place (`toggleTaskAt`) and committed the
rewritten body through plain `editEntry`.

Three checkbox behaviours, two write paths, one visible checked box — exactly the drift 0048's own
Context section already named as the reason a referenced line could never be allowed a second copy
of its own completion bit: "two rows holding the same fact is divergence waiting to happen." What
this ADR's own coordinator caught, past what 0048 and its issue #181 amendment already settled, is
that the *referenced* checkbox's own write path was itself the second surface 0048 warned about —
not a second copy of the *data* (completing through `completeTask` does write the one true Task
row, fanning out to every Entry that references it, `task-reference-sync.ts`), but a second
*surface* for the reader to reach for when they mean "done," alongside Todo's own row, with no rule
saying which is the "real" one to reach for. CONTEXT.md's own shape for an Entry — words captured
once, read afterward — never asked History to also be where a Task gets finished; it asked History
to be where a reader re-encounters what they wrote, including a checkbox they wrote before it had
anywhere else to live. Once every checkbox is conceptually a Task (0053), the honest answer to "where
does ticking happen" is "exactly one place," and Todo — not the timeline a reader is scrolling to
read, not re-tick — is that place. A checkbox in History, referenced or bare, is a reading surface:
it shows what's true, and if the reader wants to change what's true, it sends them to the one row
that owns the fact rather than growing a second door onto it.

The bare checkbox already answered the harder, mechanical half of this question in this ADR's first
cut: guessing which Task a bare line belongs to — matching its text or capture date against a live
Task's `content`/`date` — is precisely the "out-of-band matching" 0048's own Alternatives Considered
section already rejected for a referenced line, and rejected for a reason that generalizes without
changes: it fails silently. Rename the Task, or edit the checklist line, and a text match stops
matching with nothing recorded to say so; a Reference that degrades to plain text at least fails
loudly enough to be legible. A bare checkbox therefore stays inert rather than guessing, exactly as
this ADR originally decided — Promotion (synchronous, inside `sendEntry`/`commitEntryEdit`) and
0053's own one-time backfill are what eventually convert it, and the very next render after
conversion is a live, clickable reference. Nothing about that half changes here.

## Decision

**Neither checkbox shape ticks anything from History any more. Both open, or both stay inert,
governed by whether there is a Task to open at all.** A *referenced* checkbox's click
(`entry-row.tsx`'s `TaskReferenceItem`) now does exactly what clicking its words already did:
`preventDefault` stops the checkbox `<input>`'s own native check/uncheck before it can happen, and
`onOpenTask(taskId)` opens the Task's detail view over the Composer — the identical call, the
identical gate (`live !== undefined && onOpenTask !== undefined`), used by both controls, so a
reader gets the same result whichever one they tap. `completeTask`, `uncompleteTask`,
`advanceRecurringTask` and the one-line `setTaskMarkerChecked` cache splice this line used to
perform are none of them called from here any more. The checkbox still *renders* the Task's current
completed state — `resolvedChecked`, read off `live.completedAt` (or, for a recurring Task, the
Entry's own cached marker, for the identical reason ADR 0048 already gives: a recurring Task's
`completedAt` never becomes non-null, so only the Entry's own pin answers "was THIS occurrence
finished") — it is simply no longer a control that changes what it renders, the same "read, not
write" distinction Grounding's own disabled checkbox already drew for a different reason. A *bare*
checkbox — no Task to open — renders permanently disabled, unchanged from this ADR's first cut:
`entry-prose.tsx`'s `renderListItem` still accepts no handler for it at all, so there is no code
path anywhere between a bare checkbox's `<input>` and a click for a click to travel down.

**`interactive` (entry-row.tsx's `entryBodyContent`/`TaskReferenceItem`) no longer gates a
referenced checkbox's click either, because there is nothing left for it to gate.** Before this
ADR's second half, `interactive` (built from `EntryBubble`'s own `onToggleTask !== undefined`) was
what decided whether a referenced checkbox's tick was permitted — the write half of the feature,
kept separate from `onOpenTask`'s read-and-navigate half on purpose, since opening was never gated
by it even before this decision. With the write half gone, `interactive` has nothing left to gate:
a referenced checkbox's click is now governed by the identical rule its words already followed —
`live !== undefined && onOpenTask !== undefined` — independent of `interactive` entirely.
`TaskReferenceItem` still accepts `markerFrom`/`markerTo`/`body`/`entryId`/`interactive` in its own
prop type, and `entryBodyContent` still passes all four — narrowing the several-caller contract
those come from because its one current consumer stopped needing them is a bigger, riskier change
than this ticket asks for, the identical "kept, not ripped out" call this ADR's first cut already
made for `EntryBubbleProps.onToggleTask` and `composer-page.tsx`'s `handleToggleTask`.

**Composer-page.tsx keeps a non-`undefined` `onToggleTask` prop flowing to `History`, still an
intentional no-op.** `History`'s own declared prop shape (`(entry, markerFrom, markerTo) => void`)
is unowned by this ticket and is also what `entry-bubble.tsx` still reads (`!== undefined`) to
compute the `interactive` argument `entryBodyContent` takes — a read that, per the paragraph above,
no longer changes what a referenced checkbox does, only what a now-inert parameter several layers
down is handed. `handleToggleTask` stays a documented no-op for the same reason it already was
after this ADR's first cut: its only remaining job is keeping that prop non-`undefined`, not
performing a write.

## Alternatives considered

- **Guess a bare checkbox's Task by matching its text (or capture date) against a live Task.**
  Rejected on 0048's own precedent: an out-of-band match fails silently the moment either side
  changes, with nothing recorded to say the association was ever asserted, let alone broken.
- **Leave a referenced checkbox tickable, and only retire the bare one.** This was this ADR's own
  first cut, and it is what issue #231 asked this ticket to correct: a referenced checkbox's tick
  is a second, competing write surface onto the same Task Todo's own row already owns, exactly the
  divergence-of-surfaces problem 0048's Context section warns against, just one layer up from the
  data itself. Keeping it meant a reader could finish a Task from either History or Todo with no
  rule saying which was the "real" gesture, while Grounding stayed unable to do so purely because it
  never passed the handler — an inconsistency with no principled answer to "why does History get to
  tick but Grounding doesn't," once the point of History is conceded to be reading, not editing.
- **Gate a referenced checkbox's click on `interactive` the way its tick used to be gated**, so a
  caller could withhold "open" the same way it used to withhold "tick." Rejected: opening a Task's
  detail view was never gated that way even before this ADR — `onOpenTask`'s own presence already
  decides it, independently, the identical rule the words already followed — and inventing a second
  flag for the box to answer to when the words next to it don't would make the two controls capable
  of disagreeing about whether a click does anything, for no benefit either has ever needed.
- **Gate History's own render on the one-time backfill finishing first**, so a bare checkbox is
  never seen at all. Rejected: it would make an ordinary History open depend on a background
  migration's completion time, for a state that already self-corrects on its own next render with
  no reader-visible cost beyond one checkbox staying inert a little longer.

## Consequences

**1. `toggleTaskAt` (toggle-task.ts), `composer-page.tsx`'s `handleToggleTask`, and now
`setTaskMarkerChecked` (toggle-task.ts) are all dead code.** None is called from anywhere in the
app any more — `setTaskMarkerChecked`'s only caller was the recurring-occurrence splice this ADR's
second half removed from `TaskReferenceItem`. All three are left in place rather than deleted:
`handleToggleTask` still has a real job, keeping `History`'s `onToggleTask` prop non-`undefined`;
`toggleTaskAt` and `setTaskMarkerChecked` have none, and are kept only because deleting them belongs
to a different ticket than moving where completion happens.

**2. `advanceRecurringTask` (use-tasks.ts) loses its one call site inside History, but stays very
much alive.** `composer-page.tsx`'s own `handleCompleteTask` (the Task overlay's own checkbox, and
the day block's) and `todo-page.tsx`'s equivalent still call it — the Task overlay and Todo's own
row are exactly the surfaces this ADR is routing completion *to*, so it would be a contradiction for
either to lose the ability. Only the one call this ADR retires — a referenced line's own checkbox,
reached by scrolling History rather than opening a Task — is gone.

**3. A referenced checkbox that already reads checked is no longer disabled once it's a recurring
Task's finished occurrence.** Before this ADR's second half, `canToggle` refused a second click once
a recurring occurrence read checked — the mechanism behind ADR 0048/CONTEXT.md's "cannot be
reopened, rescheduled or reordered." That refusal doesn't need to exist any more: with ticking gone
entirely, there is nothing left to refuse a second click *of* — a finished recurring occurrence's
checkbox opens the Task exactly as readily as an unfinished one's does, because opening was never
what "cannot be reopened" was ever about.

**4. A checkbox that hasn't yet been converted to a reference is still temporarily inert, with no
special UI for that state.** Unchanged from this ADR's first cut: it reads exactly like Grounding's
own permanently read-only checkbox — unchecked or checked per its own cached marker, disabled,
nothing to click — until Promotion or the backfill rewrites its line, at which point its very next
render is the live, clickable-to-open reference shape with no reader action required.
