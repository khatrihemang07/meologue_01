# 0053: Every checkbox is a Task, and existing History is backfilled

## Status

Accepted. Builds on [0047](0047-a-task-is-a-second-root-noun.md) (the Task row this ADR mints out
of old writing) and [0048](0048-a-task-reference-is-a-node-with-a-cached-label.md), whose
`[[task:id|label]]` mark and loop guard (`referencedTaskOf`/`isAlreadyReferenced`) this ADR reuses
verbatim rather than inventing a second recognition rule for the identical shape. Reuses
[0043](0043-an-entry-may-carry-structure.md)'s checkbox list items — the thing this ADR backfills —
and issue #173's own Promotion (`apps/web/src/lib/promote-tasks.ts`), which already turns a bare
checkbox into exactly this shape for anything written *after* it shipped; this ADR is what happens
to everything written *before*. Amended by issue #181: the day block gains completion state, a
done/total count, ticking and opening — see the "Amendment (issue #181)" section at the end for why
that is not a reversal of anything this ADR actually decided. Leans on [0016](0016-export-per-day-text-plus-a-lossless-manifest-grouped-by-local-day.md)'s
"a backup that quietly omits things is worse than none" precedent for reading the whole of History
at once, and on [0039](0039-digests-gain-revisions-and-can-be-asked-for.md)'s staleness mechanism,
which the backfill's own Entry rewrites trigger for free, the same way any other Entry edit does.
Supersedes nothing.

## Context

Promotion (issue #173) made every checkbox written in an Entry a Task, automatically, from the
moment it shipped. It did nothing for the checkboxes already sitting in History — every `- [ ]` and
`- [x]` a reader had already written before that Device updated. Without a backfill, Todo's Inbox
starts empty on a Device with years of journalling behind it, and the day block this same ticket
adds (history.tsx's `DayTasksRow`) would open every day already in History with nothing at all,
even a day that plainly listed things to do. CONTEXT.md's own Task entry says "every checkbox
written in an Entry is a Task" without carving out an exception for when it was written — a backfill
is what makes that sentence true of the Entries that already exist, not just the ones still to come.

The obvious tool for this job is also the dangerous one. `packages/core/src/quick-add/`'s parser is,
by its own design, "deliberately over-eager" — recognising `monday`, `evening`, `monthly` out of
ordinary prose is a feature in the add field, where a wrong guess lights up and a click sends it
back to plain text before anything is stored. A migration has no such moment. It runs once, over
everything, silently, and whatever it decides is what a reader finds waiting for them the next time
they open Todo. Todoist's own documentation names the exact failure this invites: "Create **monthly**
report" becoming a recurring Task nobody asked for, because the word "monthly" appeared in an
otherwise ordinary sentence. Run the full parser — the one the add field trusts, precisely because a
reader is watching it as they type — over years of unwatched prose, and the false positives are not
a tail risk; they are the expected outcome the very first time a diary entry mentions a weekday by
name.

## Decision

**Every checkbox already in History becomes a Task**, ticked ones included. A ticked line becomes a
*completed* Task rather than being left alone or silently dropped, so the record stays honest — an
Entry that already said "done" keeps saying so as a Task, rather than becoming an open Task that
looks freshly unfinished. Completed Tasks are filtered out of every active list (`TaskStore.list()`'s
own guarantee), so only the genuinely unfinished lines surface anywhere a reader looks. Day one's
Inbox becomes exactly the set of things the reader wrote down and never finished — arguably the
single most useful thing this feature can show on a Device with real history behind it.

**The backfill is Promotion, called once per Entry, not a second parser.** `apps/web/src/lib/backfill-tasks.ts`'s
`backfillTasksFromHistory` reads every Entry (`store.list()` with no page argument — ADR 0016's own
"everything, or it isn't really a backup" reasoning, applied here to a migration instead of a zip)
and calls `promoteBareCheckboxes` (promote-tasks.ts) on each one, exactly as `use-history.ts`'s
`sendEntry`/`commitEntryEdit` already do for a live Send or edit. The ProseMirror round trip, the
loop guard that skips a line already carrying a Reference, the Task fields a parse resolves to — all
of it is the one implementation issue #173 already built and already tests, reused rather than
duplicated a second time with its own chance to drift from the first.

**A confidence gate sits in front of the reused parser, and only there.** `promoteBareCheckboxes`
gained one new, optional parameter for this — `confidenceGate: (token: QuickAddToken) => boolean`
— left `undefined` by every live-Composer caller (Promotion's own behaviour is completely unchanged)
and supplied only by the backfill. A token the gate returns `true` for is folded into the demoted set
`parseWithDemotions` already knows how to honour, the identical mechanism a reader's own click uses
in the add field — refusing a class of token programmatically is not a new idea bolted on beside
demotion, it is demotion's own machinery, driven by a rule instead of a click. The gate refuses:

- **A bare recurrence word** (`matchRecurrenceWord`'s own candidates) — Todoist's own documented
  false positive, named by this ticket's own example.
- **A bare weekday used as a noun** — a `date` token whose entire matched text is one of
  `QuickAddLanguage.weekdays`'s own keys and nothing else. A *modified* weekday (`next monday`,
  `this fri`) always matches more than one word and is untouched by this rule — "call mum on
  **Monday**" stays a date; "**Monday**'s meeting notes are still in my head" does not become one.
- **A bare fuzzy time word** (`morning`/`noon`/`afternoon`/`evening`/`night`/`midnight`) — at least as
  common in ordinary prose as a weekday noun ("had a lovely **evening**" is not a due time), refused
  by the identical reasoning even though the ticket's own examples only name weekdays and interval
  words by name. An *explicit* clock time (`5pm`, `17:00`) carries none of that ambiguity and stays
  trusted.

Everything else the parser recognises — an explicit calendar date, `today`/`tomorrow`, an explicit
offset (`in 3 days`), an explicit clock time — is high-confidence enough to promote unwatched, and is
promoted exactly as Promotion would promote it today.

**Where nothing parses, the Task takes the Entry's own capture date**, day-only —
`promotedTaskToTask`'s existing capture-date rule (issue #173), reused rather than reimplemented, and
now exercised for the first time against genuinely old text. A relative phrase that *does* parse is
resolved against the Entry's own capture day, not the day the backfill happens to run on: `tomorrow`
written into an Entry from March 2024 means the day after that Entry was captured, never a Monday
years away computed against today's real date. Each Entry gets its own `QuickAddOptions.now` for
this reason, set once per Entry before its checkbox lines are even looked at.

**Idempotence comes from the loop guard, not a transaction.** `packages/core/src/sqlite/migrator.ts`'s
own comment is explicit that this database has none — Tauri pools connections, so a `BEGIN` and the
statement immediately after it are not guaranteed to reach the same connection, and a transaction
issued anyway would appear to protect the migration while protecting nothing. This backfill never
asks for one. Safety instead comes from the same property that already makes Promotion itself safe
to run twice: a checklist line that already carries a `[[task:id|label]]` Reference is left
completely alone. Interrupting the backfill partway — the process dies, the tab closes — and running
it again from the very first Entry does no harm: every line already rewritten is now a Reference and
is skipped exactly as an ordinary Send with nothing new to promote would be, and only the genuinely
unprocessed remainder does any work. Each Entry is written immediately once its own Tasks are minted
— never batched to the very end — so an interruption leaves everything already processed fully
committed, with nothing to redo.

**The day block is a rendering, never a record.** Each day in History opens with a block of the
Tasks dated or deadlined that exact day (`task-views.ts`'s `tasksForDay`, `history.tsx`'s
`DayTasksRow`), built by filtering whatever Tasks are already in memory — nothing about it is stored,
cached against a day key, or written anywhere. A Task re-dated from the 31st to the 1st keeps its own
Reference in the Entry written on the 31st and simply starts satisfying `tasksForDay(tasks,
"...-01")` instead of `"...-31"` the next time either is asked; there is no membership row to update,
because none was ever written. It is, by construction, invisible to Export (`groupEntriesIntoDayFiles`,
`packages/core/src/export/day-file.ts`, takes only `Entry[]` — there is no `Task[]` parameter for a
day block to have leaked through even by accident), to Digest grounding, and to embeddings: a Task
reaches all three through its own path, and nothing here duplicates that path or races it. A Task
with neither a date nor a deadline satisfies no day and appears in none.

## Alternatives considered

- **Promote only checkboxes written from now on, and leave History alone.** The simplest option, and
  the one issue #173 already shipped by itself. Rejected as *this* ticket's answer because it leaves
  day one's Inbox empty on every Device with real history behind it — the single most useful thing
  this feature could show a returning reader, gone for no reason but sequencing.
- **Run the full, unmodified quick-add parser over every checkbox in History.** The most literal
  reading of "reuse Promotion" — call the exact same parser, no gate in front of it. Rejected because
  it manufactures commitments silently: a diary entry that happens to say "meeting on Monday" as
  prose becomes a dated Task nobody asked for, with no demotion moment to catch it before it's
  written, unlike the add field this parser was actually designed to sit behind. The ticket's own
  standing warning — "there is nobody here to catch it" — is precisely this alternative's failure
  mode, not a hypothetical one.
- **Store the day block as rows** — a table mapping a day key to the Tasks that belong to it,
  maintained on every write that touches a Task's date or deadline. Rejected: it is a second copy of
  exactly what a Task's own `date`/`deadline` fields already say, immediately stale the moment either
  changes on a re-date, and the maintenance it would need (find every day-block row referencing a
  Task, delete or move it, on every schedule change) duplicates work `tasksForDay`'s own plain filter
  already does for free, correctly, on every read.

## Consequences

**1. A checklist line's words can now be quietly rewritten by something other than a reader's own
edit, for the first time at scale.** Promotion already established that Sending a checkbox line
mints a Task and swaps its own text for a Reference (ADR 0048's own consequence #1); this ADR is the
same act, running once, retroactively, across however much History a Device holds. The confidence
gate exists specifically to bound how much of that rewriting can be wrong in a way nobody is watching
for — see the Decision above for exactly what it refuses and why.

**2. The backfill's own writes are ordinary Entry edits, and inherit everything ADR 0043 already
attached to one.** A rewritten body Syncs, and stales the Digest for whatever Period the edited
Entry falls in (ADR 0039) — the same "reading your History can now change it" consequence ADR 0043
already named for a reader's own tick, now also true of a migration's tick. Nothing here is a
special, quieter write path.

**3. `promoteBareCheckboxes` gained a fifth, optional parameter.** `confidenceGate` defaults to
`undefined`, and every existing call site — the live Composer's Send, its edit-commit, and every
test that predates this ticket — leaves it unset and observes byte-identical behaviour to before
this ADR. The parameter exists at all only because the backfill needed a way to say "refuse this
token regardless of what a live reader might otherwise have let through," without opening a second,
parallel implementation of the ProseMirror walk, the loop guard, or the Task-field resolution that
already lived in this one function.

**4. `use-history.ts`'s `promotedTaskToTask` moved from a closure to a module-scope export.** The
capture-date rule it encodes — "the parsed date wins; the Entry's own capture date is only a
fallback" — now has exactly one implementation, called by a live Send/edit-commit and by the backfill
alike, rather than a second copy the backfill would otherwise have needed to keep in step by hand.

**5. A fresh Device with no History yet pays nothing.** `backfillTasksFromHistory`'s own cheap
pre-check (`mightHoldACheckbox`) skips the ProseMirror parse entirely for an Entry that never
contained `[ ]`/`[x]` at all, and `runTasksBackfillOnce`'s own local flag (`localStorage`, mirroring
ADR 0008's "Device-local configuration, held outside the entry store" for a migration marker rather
than a UI setting) means a fully-backfilled Device does not re-scan its whole History on every later
open. Losing that flag — a cleared browser profile, a fresh install — costs one redundant, still
perfectly safe re-scan; it is a performance optimisation, never the source of correctness, which
stays with the loop guard exactly as it does mid-run.

## Amendment (issue #181): the day block ticks and opens, and this ADR's own Decision needed no change to say so

Issue #181 gave the day block (`history.tsx`'s `DayTasksRow`) three things it didn't have before:
completion state for each Task it lists (done or undone, with a done/total count), a checkbox that
actually completes an undone one, and a click that opens a Task's own detail view over the Composer.
`history.tsx`'s own `DayTasksRow` doc comment, before this amendment, argued the block had to stay
read-only forever: ticking there would give a Task "two places its own completion could be toggled
from," the identical two-copies risk this ADR's sibling, [0048](0048-a-task-reference-is-a-node-with-a-cached-label.md),
already refused for a Task's name and completion bit.

**That argument was wrong for the reason it gave, and this amendment is the record of why, not a
reversal of anything this ADR's own Decision actually said.** Re-read this ADR's own words above:
"the day block is a rendering, never a record… nothing about it is stored, cached against a day
key, or written anywhere." That claim is about *day membership* — whether there is a table
mapping a day to the Tasks that belong to it — and it is exactly as true after issue #181 as
before it. `onCompleteTask` (the day block's new prop, wired by `composer-page.tsx`) calls straight
through to `completeTask`/`advanceRecurringTask` (`use-tasks.ts`), the identical single write
`task-row.tsx`'s own checkbox already performs on the identical `tasks` table. No second place
remembers a Task's completion; no day-key-to-Task membership row exists now that didn't exist
before. What ADR 0048 actually refuses is a *second stored copy* of a fact ADR 0047 already owns —
that is what "two places it could be toggled from" has to mean for it to be a real risk, and a
second **rendering** reading and writing the identical row through the identical mutation is not
that. Today and Inbox already read and write the same `tasks` table from two different rows with no
such objection; the day block joining them is the ordinary case of a personal task list rendered
more than once, not a new one.

**What issue #181 actually needed from Events (ADR 0056), not from this ADR.** A completed
*occurrence* of a recurring Task is the one case `tasksForDay`'s plain date/deadline filter cannot
answer on its own: `advanceRecurring` moves `date` on to the next occurrence the moment one
finishes, and a recurring Task's own `completedAt` never becomes non-null at all (CONTEXT.md's
Recurrence entry). `completedRecurringOccurrencesForDay` (`packages/core/src/task-views.ts`) answers
it instead, from the `"completed"` Event `advanceRecurring` already records — a fact ADR 0056 gives
this app for the first time, which is why this couldn't have been solved when this ADR shipped. The
day block still reads it purely from memory, still writes nothing of its own, and an occurrence's
own record still cannot be reopened or rescheduled once shown (CONTEXT.md's Occurrence entry) — the
identical rule `entry-row.tsx`'s `TaskReferenceItem` already enforces for a referenced checkbox,
applied here to a second surface rather than invented twice.

No code in this ADR's own Decision needed to change. `history.tsx`'s own `DayTasksRow` doc comment
did — issue #181 rewrote it to state the ticking/opening behaviour and the reasoning above directly,
rather than the inverted argument this amendment now retires.
