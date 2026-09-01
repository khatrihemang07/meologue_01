# 0048: A task reference is a node with a cached label

## Status

Accepted. Extends [0042](0042-a-reference-is-a-mark-in-the-body.md)'s `[[…]]` dialect with a
second mark rather than opening a second one, and relies on
[0043](0043-an-entry-may-carry-structure.md)'s checkbox list items, which is what a task reference
sits inside. Depends on [0047](0047-a-task-is-a-second-root-noun.md) for the Task existing as its
own row in the first place, and on
[0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md) for the row-level
last-writer-wins rule this ADR builds its argument on. Supersedes nothing.

## Context

A list item in an Entry's body has no identity of its own. The body is one Markdown string, and
ADR 0043 already decided that editing an Entry rewrites that string wholesale —
`entryDocumentToMarkdown` serializes the whole document, not a line at a time. A plain checkbox
line, `- [ ] buy milk`, is therefore only ever *found* by its position or its text; there is
nothing in it that survives a save the way a database row's id would. Once a checkbox needs to
carry a due date, a project, a priority — the properties ADR 0047 gave the Task that now owns it —
the body needs something stable to point at that Task with, because the Task's own row is the only
place those properties can live.

ADR 0042 already solved exactly this problem for days and other Entries: a `[[…]]` mark is text
the user's own edit can't accidentally break in the way a database foreign key would prevent, and
an unresolvable one degrades to plain text rather than an error. A task reference is the same
problem wearing a checkbox instead of a sentence, and it belongs in the same dialect — the mark set
`referenceParser` and the block parser ADR 0043 installed both read from — rather than a second
dialect that risks meaning one thing when read and another when written, which is precisely the
failure ADR 0043's "one dialect" decision exists to rule out.

The sharper problem is what happens once the reference exists. A Task has a name and a completion
bit. The Entry's checkbox line, rendered, also shows a name and a completion bit. Under ADR 0028's
row-level last-writer-wins, two rows holding the same fact is divergence waiting to happen: the
Task is one row with its own `seq`, the Entry is another row with its own `seq`, and nothing ties
their writes together. Edit the Task's name on one Device while the Entry syncs unrelated changes
on another, and there is no rule that decides which of two now-different copies of "buy milk" is
correct — because both would be, by the only rule Sync has. Divergence isn't a risk to be managed
here; it is the *default outcome* of any design that keeps two copies.

## Decision

**A task reference is a node in an Entry's body carrying a cached label: `[[task:id|label]]`.**
It extends ADR 0042's dialect with a third mark form, alongside `[[YYYY-MM-DD]]` and `[[e:<id>]]`,
recognised by the same `referenceParser` and rendered by the same block-aware path ADR 0043
installed. The label and the checkbox's `[ ]`/`[x]` state are **caches** — written from the Task
at the moment the reference is created or the Task changes, and never treated as a second source
of truth.

**The Task owns the text.** There is exactly one copy of the name and exactly one copy of the
completion bit, and both live on the Task's own row. Everything else — the checkbox rendered in an
Entry, the line Export writes, the row Todo shows — reads from that one copy rather than keeping
one of its own.

**Ticking writes the Task; the body's marker follows as a consequence, not as a second write.** A
reader clicking a checkbox in an Entry changes the Task's completion, the same act as ticking it in
Todo. The cached marker in the Entry's body is then refreshed to match — one logical write, one row
that actually moves.

**Export writes the cached label, not the mark.** A day file reads `- [ ] buy milk`: real words a
person can read without the app, not a pointer that means nothing outside it. That is what keeps
ADR 0016's "human view" half of Export honest for a Task-bearing line exactly as it already is for
everything else in a day file.

**A cache write still counts as editing an Entry.** Refreshing a checkbox's marker or its label
goes through the same path any other Entry edit does, and inherits everything ADR 0043 attached to
that: it Syncs, and it stales the Period's Digest (ADR 0039). This applies in both directions —
ticking a checkbox stales the Digest for the Period the *Entry* falls in, and renaming a Task
refreshes the label in every Entry referencing it, staling every Period any of those Entries falls
in. Neither is carved out as a special, quieter case; ADR 0043's "reading your History can now
change it" consequence simply has a second way to trigger.

**An unresolved task reference is its own cached label, and leads nowhere.** A reference to a Task
this Device hasn't Synced yet renders the label it was created with — the words are already there,
because they were cached at write time — but the line isn't clickable and doesn't resolve to a live
Task until the Task itself arrives. This is ADR 0042's "unresolved is plain text" rule applied
identically: nothing about a task reference needing a Task's own row changes what happens when that
row hasn't shown up yet.

**Deletion is asymmetric, and nothing is silently rewritten.** Deleting a Task leaves the Entry's
line exactly where it was, as the plain text of its last cached label — the checkbox stops being a
live reference to anything, but the words the user wrote to describe it are never removed on their
behalf. Deleting an Entry leaves every Task it referenced untouched; a Task's row is not contingent
on any Entry pointing at it, because ADR 0047 gave it a lifecycle of its own.

## Alternatives considered

- **A visible id marker with two independent copies of the text.** Store the label in the Entry's
  body as ordinary characters, `- [ ] buy milk [[task:k3f9]]`, and let the Task's own name be a
  second, separately-editable copy. Rejected: this doesn't merely risk divergence, it guarantees it
  under ADR 0028's row-level last-writer-wins — two rows, two `seq` values, no rule that ties their
  writes together. The two copies drift the first time either side is edited offline on two
  different Devices, which is not a rare failure mode for a local-first app; it is the ordinary one.
- **Out-of-band text matching**: find the checkbox line in an Entry whose text equals a Task's
  current name, with no mark at all. Rejected: it breaks silently the moment either side is edited
  — rename the Task, or reword the checkbox line, and the match is gone with nothing to say so. A
  Reference that degrades to plain text (ADR 0042's rule) fails loudly enough to be legible; a match
  that quietly stops matching fails in a way that has no recovery, because there was never anything
  recorded to recover from.
- **Storing structured task data in a second Entry field**, mirroring the `replyTo` field ADR 0042
  rejected and the separate-structured-field option ADR 0043 rejected for the same reason each
  time: a second representation to keep in step, a client and server migration, and a
  `PROTOCOL_VERSION` bump that 426s every Device that hasn't updated — for something the one `[[…]]`
  dialect already expresses as characters. It loses here for the same reason it lost twice before.

## Consequences

**1. The round-trip property test over `entryMarkdownToDocument`/`entryDocumentToMarkdown` is
extended, not bypassed.** The existing suite already asserts that every construct the dialect
accepts survives a parse-then-serialize round trip unchanged; a task reference is a new construct
in the same dialect and is folded into that same property, not exercised by a parallel test that
could drift out of step with it.

**2. The Composer's schema gains an inline atom node.** A task reference sits beside the existing
`reference` atom rather than replacing it, carrying the Task's id, its cached label, and its
checked state as node attributes — so the editing surface cannot represent a half-typed or
malformed reference the way free text could; a task reference is either a complete node or it is
plain text, with nothing in between for a save to serialize incorrectly.

**3. Reading History can now change it in a second way.** ADR 0043's consequence that "reading your
History can now change it" already covered ticking a bare checkbox. It now also covers ticking a
checkbox that carries a task reference — the same act, writing the same kind of change, just
landing on the Task's row first and the Entry's cached marker second instead of the Entry's body
directly.

**4. A Task's name is no longer something only Todo can change.** Renaming a Task from Todo now has
a visible effect inside History: every Entry holding a reference to it shows the new label the next
time it's read. This is the label being a cache doing exactly what a cache is for, and it is worth
naming because it's the one place in meologue where an edit made in one Destination visibly changes
text rendered in another.
