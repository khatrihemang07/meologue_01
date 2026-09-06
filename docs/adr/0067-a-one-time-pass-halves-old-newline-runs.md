# 0067: A one-time pass halves old newline runs, guarded by a fixed cutoff

## Status

Accepted. Directly repairs the writing [0066](0066-enter-is-a-soft-break.md) left behind: that ADR
fixed the keystroke going forward, from the build it shipped in, and said nothing about the years of
Entries already written under the old one. Reuses [0043](0043-an-entry-may-carry-structure.md)'s
`entryMarkdownToDocument`/`entryDocumentToMarkdown` round trip verbatim — the blessed way to rewrite
a body — the identical tool [0053](0053-every-checkbox-is-a-task-and-existing-history-is-backfilled.md)'s
Task backfill already reused for the same reason. Follows
[0057](0057-a-field-added-to-an-existing-stream-triggers-one-cursor-reset.md)'s own precedent twice
over: its `kv`-backed, per-stream marker is the shape this ADR's own "already ran" flag copies, and
its choice to amend `CONTEXT.md`'s Cursor entry rather than leave code and prose disagreeing is the
choice this ADR makes for the Entry entry, below. Leans on [0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md)
for what a body rewrite already means for Sync, and on [0039](0039-digests-gain-revisions-and-can-be-asked-for.md)
for what it already means for a Digest. Reads a row's own `updated_at`
([0065](0065-a-row-records-when-it-last-changed-and-that-travels.md)) as its per-row guard. Does
**not** take a safety Backup before running, unlike Restore
([0064](0064-a-backup-is-a-sql-dump-restore-replaces-and-merge-folds-in.md)) — see "The invariant that
replaces a safety Backup" below for why a different guarantee stands in for one here. Supersedes
nothing.

## Context

[0066](0066-enter-is-a-soft-break.md) made Enter insert a single `\n` instead of splitting the
paragraph. That fixed the keystroke; it did nothing for the Entries already sitting in History.
Every one of them still carries the old shape: one Enter pressed once stored `\n\n` (a blank line),
and a deliberate blank line stored `\n\n\n\n`. Read under the new, correct reader, that old writing
still renders exactly the defect 0066 fixed — a blank line everywhere the writer only ever pressed
Enter once — except now it's permanent, because nothing about opening the app, editing something
else, or Syncing ever touches a body nobody edits.

This is fixable, and fixable *exactly*, because the old behaviour was consistent: it multiplied
every Enter by two. A run of `\n` of even length `2k` in an Entry written before 0066 shipped is
`k` old Enters typed back to back, and halving it recovers exactly what `k` Enters mean today. An
odd run cannot have come from Enter alone under either the old or the new keymap, so it is never a
candidate at all — see "the pure transform" below for the one other place a `\n\n` can come from
that this fact alone does not distinguish.

**A blanket string replace corrupts structure and must not be used.** `writeBlocks`
(`entry-document.ts`) writes a genuine blank line ahead of a paragraph that follows another block,
because a lone `\n` is a CommonMark lazy continuation — the parser folds the second line back into
whatever sits above it rather than reading it as a paragraph of its own — and ahead of an ordered
list whose numbering does not start at 1, because CommonMark only lets such a marker interrupt an
already-open block when it starts at 1. Neither of those `\n\n`s is an Enter; halving either
corrupts the document rather than merely reformatting it: `- item\n\nafter` would fold "after" into
the list item, and `a\n\n5. five` would stop being a list at all. A transform that cannot tell these
apart from an old Enter is not safe to run unattended over years of unwatched writing — the identical
caution [0053](0053-every-checkbox-is-a-task-and-existing-history-is-backfilled.md)'s own Context
names for a different parser run the same way.

## Decision

### The pure transform

`halveSoftBreakRuns(body: string): string` (`apps/web/src/lib/soft-break-migration.ts`) never
touches a raw string. It parses `body` through `entryMarkdownToDocument`, walks the resulting
document, and serializes back through `entryDocumentToMarkdown` — the same round trip
[0043](0043-an-entry-may-carry-structure.md) built and `promoteBareCheckboxes`
([0053](0053-every-checkbox-is-a-task-and-existing-history-is-backfilled.md)) already reuses to
rewrite a body safely.

Only a top-level `paragraph` child of the document is ever rewritten, and only inside a `text` leaf
that does not carry the `code` mark: every run of `\n` of even length `2k` becomes `k` newlines; an
odd run is left exactly as written. Three places are never touched at all, and each is a *proof*,
not merely a policy:

- **Inside a `bullet_list`/`ordered_list`.** Enter inside a list item has always been
  `splitListItem`, on both sides of 0066's keymap change, never a block split — no `\n\n` a list
  item's own content holds was ever produced by pressing Enter, so there is nothing here to halve.
- **Inside a `code` mark.** An Enter typed while an inline code span was open would have produced
  two separate code spans on either side of it, never one span whose own text contains `\n\n` — the
  shape simply cannot arise from typing.
- **Inside a `reference`/`task_reference` atom.** A Reference's own `raw` cannot contain a newline
  at all — the parser that recognises `[[…]]` does not allow one inside the brackets. A task
  reference's `label` is a cache, rewritten from the Task on every render
  ([0048](0048-a-task-reference-is-a-node-with-a-cached-label.md)); rewriting its characters here
  would desync it from the Task that owns them.

**The one case that needs care rather than a blanket rule: a paragraph's own leading `\n` run.**
`writeBlocks` never inserts a separator ahead of a paragraph directly — a paragraph sibling that
follows another top-level block already carries whatever gap preceded it as part of its own leading
text, verbatim, because `parseEntryMarkdown` never trims it. That means a top-level paragraph that
is not the document's very *first* child always begins with the separator that put it there — not
an Enter — and that leading run is preserved exactly as written. The document's first top-level
child has no such separator ahead of it (nothing precedes it to separate from), so a leading run
there, if it has one at all, is an Enter pressed before any other typing, and is halved like any
other.

### The cutoff

Every Entry is guarded per-row, not by a single flag: an Entry whose `updated_at`
([0065](0065-a-row-records-when-it-last-changed-and-that-travels.md)) is at or after
`BODY_SOFT_BREAK_CUTOFF` — a fixed instant, in `packages/core/src/protocol.ts`, marking when the
build that ships 0066 became the running build — is skipped outright. Its body was written by a
build where one Enter is already one `\n`; there is nothing old-shaped left in it, and halving it
regardless could only ever remove a blank line the writer placed on purpose.

This constant lives beside `ROW_SHAPE_EPOCH` for the identical reason that map does: it has to read
identically on every Device for convergence to hold at all. `EntryStore.edit` stamps `updated_at`
on every write, and that field travels on the wire
([0065](0065-a-row-records-when-it-last-changed-and-that-travels.md)) — so a row this migration
rewrites on one Device arrives at every other Device already past the cutoff, and is skipped there
without ever being re-examined. This is what makes halving — an operation that is emphatically
**not** idempotent (`\n\n\n\n` → `\n\n` → `\n`, a second halving pass removes a real blank line the
first pass already resolved) — safe to re-run: correctness comes from the timestamp, not from
remembering that a pass already happened.

**Write only when the body actually changes.** The runner compares `halveSoftBreakRuns(body)` against
`entryDocumentToMarkdown(entryMarkdownToDocument(body))` — the plain round trip, with no halving
applied — and writes only when they differ. Comparing against the round trip rather than against
`body` itself is deliberate: several real bodies normalise under the plain round trip for reasons
that have nothing to do with a newline at all (an ordered list's `)` delimiter becomes `.`; a lone
`~` gains an escaping backslash — both found directly in `entry-document.test.ts`'s own corpus), and
comparing against `body` would make every one of those Entries look "changed" and get rewritten,
Synced, and marked pending for no reason connected to this migration at all.

### The "already ran" marker

An optimisation only, kept in `kv` (`SOFT_BREAK_MIGRATION_KEY`, `packages/core/src/sqlite/schema.ts`)
rather than `localStorage`, mirroring `CURSOR_KEY`/`ROW_SHAPE_EPOCH_KEY`'s own placement
([0057](0057-a-field-added-to-an-existing-stream-triggers-one-cursor-reset.md)). Restore restores
`kv` — a marker kept in `localStorage` would survive a Restore and leave the Restored, potentially
pre-migration rows permanently unmigrated, the exact failure this placement exists to avoid. It is
never the source of correctness — the per-row cutoff above is — so losing it (a cleared profile, a
Restore, a Merge) costs one redundant, still-safe re-scan of History, never a double-halved body.

**Restore and Merge both explicitly re-arm this marker, unconditionally, on every run of either.**
Restore's own `kv` handling only upserts rows a Backup file actually names, and a Backup taken
before this migration existed never names this key at all — left alone, a Device that had already
migrated before Restoring such a Backup would keep the marker set, and the just-Restored,
pre-migration bodies would never be revisited. Merge excludes `kv` outright, so without an explicit
step a Device that already ran this migration would keep the marker after folding in another
Device's rows, including rows that Device never migrated. Both `restoreFromBackup` and
`mergeBackupIntoDevice` therefore delete this one `kv` row unconditionally, every time, the identical
always-reset-regardless-of-the-file posture `resetCursorsAndEpochs` already takes for Cursors on
Restore. Re-arming a Device that had, in fact, migrated everything it just Restored or Merged costs
one redundant, still-safe re-scan — a far cheaper mistake than a Restored or Merged History staying
silently unmigrated forever.

### The invariant that replaces a safety Backup

Restore takes a safety Backup before it writes anything
([0064](0064-a-backup-is-a-sql-dump-restore-replaces-and-merge-folds-in.md), issue #204). This
migration takes none — on the web build, the only mechanism available for that is a download
prompt the reader did not ask for, appearing the moment the app opens, which is a worse experience
than the defect this migration exists to fix. What has to stand in for it is a property of the
transform itself, proved rather than assumed: **`halveSoftBreakRuns` only ever removes `\n`
characters.**

`entry-document.test.ts` asserts this directly, across its entire existing round-trip corpus (500+
bodies, every shape the dialect can produce): stripping every `\n` from `halveSoftBreakRuns(body)`
and from the plain round trip of the same body must leave the two identical. If this transform could
ever drop a word, unwrap a mark, delete a Reference, or collapse a list, some corpus entry would
show it. None does. This is also why `halveSoftBreakRuns` always parses and re-serializes, even a
body with no `"\n\n"` at all, rather than short-circuiting by returning it verbatim: a short-circuit
would make the function disagree with the plain round trip on exactly the non-newline characters
that round trip already normalises for unrelated reasons, undermining the very property this
invariant exists to prove. (The runner's own scan skips such a body before calling this function at
all, for performance — see "the cutoff," above — which is where that shortcut actually belongs.)

## Alternatives considered

- **A blanket string `replace`, halving every `\n\n` wherever it appears.** Rejected in Context
  above: it cannot tell a genuine Enter from a block separator or a non-1 ordered-list guard, and
  corrupts structure rather than reformatting it.
- **A device-local flag as the sole guard, with no per-row cutoff.** Rejected: a flag on this Device
  cannot see that a row was already migrated (and pushed) by a *different* Device, so that row would
  be halved a second time here, silently removing a real blank line the first Device's own pass had
  already resolved correctly. The per-row `updated_at` cutoff is what makes convergence hold across
  Devices; the flag is only ever a local optimisation on top of it.
- **Taking a safety Backup before this migration runs, mirroring Restore.** Rejected for the reason
  named above: on web that means an unsolicited download on every app open until the pass has run
  once, which is a worse experience than the blank-line defect being fixed. The invariant test
  substitutes a proof for a copy.
- **Suppressing Sync/Digest staleness for a migrated body**, so a background pass never shows up as
  "new" activity. Rejected — see Consequences below.

## Consequences

**Rewritten bodies Sync ([0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md)) and stale their day's
Digest ([0039](0039-digests-gain-revisions-and-can-be-asked-for.md)), exactly as any other edit
does.** Suppressing either would be worse: a Device that migrates its own bodies locally without
pushing them diverges from every other Device permanently, and the first ordinary edit made to the
same Entry anywhere else would push an un-migrated body back over it, undoing the fix. Accepting the
Sync and the staleness is what keeps every Device converging on the same, correctly-halved text.

**Two accepted failures, both named rather than silently tolerated:**

- **Clock skew on a badly-set Device.** The cutoff compares against `updated_at`, which is stamped
  from that Device's own clock. A Device whose clock reads meaningfully behind the real release
  could stamp a genuinely post-0066 edit with a timestamp this migration reads as pre-cutoff, and
  halve a real blank line out of it. This is the same clock-skew exposure
  [0065](0065-a-row-records-when-it-last-changed-and-that-travels.md)'s own Merge already accepts for
  `updated_at` generally, not a new one this ADR introduces.
- **An Entry written by an old build after the cutoff.** A Device that has not yet updated past
  0066's own build keeps producing the old, doubled-newline shape after the cutoff instant has
  already passed elsewhere. Its `updated_at` reads past the cutoff, so this migration skips it
  forever, and that Entry keeps its spurious blank line permanently. This is cosmetic — a wrong
  blank line, never a lost word — and is accepted rather than solved by, for instance, versioning
  the cutoff per-build: the added complexity is not warranted for a stale-client window this app's
  own scale (`CLAUDE.md`) makes short-lived in practice.

**`CONTEXT.md`'s Entry entry is amended, not preserved as written**, following
[0057](0057-a-field-added-to-an-existing-stream-triggers-one-cursor-reset.md)'s own precedent for
the Cursor entry. It said, without qualification, "An Entry that is never edited keeps the exact
characters it was captured with." [0053](0053-every-checkbox-is-a-task-and-existing-history-is-backfilled.md)'s
own Task backfill already made that false — it rewrites a checkbox line into a Task Reference the
first time this app modelled a checkbox as a Task at all, on an Entry nobody touched — and never
amended the glossary to say so; that debt is paid here, alongside this ADR's own, second exception.
The entry now names both directly, bounded the same way 0057 bounded its own: each runs **at most
once** per Entry (0053's own loop guard; this ADR's own per-row cutoff), never as an ordinary
consequence of Syncing or of opening the app on an Entry the cutoff has already passed.
