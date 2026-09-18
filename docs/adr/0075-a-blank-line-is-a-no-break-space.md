# 0075: A blank line is a paragraph holding one no-break space

## Status

Accepted. Closes the gap [0069](0069-enter-splits-a-block-and-shift-enter-is-a-soft-break.md) left
open. 0069 made Enter split a block and Shift+Enter a soft break, and made the two distinguishable in
storage — `\n\n` against a GFM backslash hard break. It did not give an empty paragraph a spelling,
and said so: pressing Enter twice produced a blank line in the Composer that did not survive Send and
reload. This ADR is that spelling. UpNote keeps a blank line because it stores HTML, where one is a real
`<div><br></div>` block, byte-verified in the macOS gap sweep's block-model table. We keep
Markdown, so the behaviour has to be re-derived rather than inherited. The assertion that would
have caught this is described in Consequences.

## Context

Markdown has no way to say "an empty paragraph". A run of newlines collapses to a single block break
on read, which is CommonMark's blank-line rule doing exactly what it is specified to do. So `alpha` ⏎
⏎ `bravo` showed a blank line in the Composer, and lost it the moment the Entry was Sent and
re-opened.

The Composer's own keystroke tests for this case passed throughout. They were not wrong; they were
incomplete. They replay keystrokes into a live Composer and read the resulting document back, and
never write that document down. A break
surviving the Composer and a break surviving storage are two different claims, and the suite was only
ever making the first one.

0069 deliberately did not invent an encoding. Nothing in #234's acceptance criteria asked for one, and
guessing at a body encoding in passing is how a format acquires a rule nobody can later explain.

## Decision

**A deliberately blank line is stored as a paragraph whose entire content is one U+00A0 NO-BREAK
SPACE, and nothing else.**

The character is not arbitrary. CommonMark's blank-line rule counts a line as blank when it holds "no
characters, or only spaces or tabs". A no-break space is neither, so a line holding only one survives
being written down and read back as genuine paragraph content, while a line holding only an ordinary
space collapses into the block break either side of it — which is the very failure this ADR exists to
fix, and the reason an ordinary space cannot be the marker.

This was established against the real reader before anything was written: `"alpha\n\n<U+00A0>\n\nbravo"`
already parsed to three prose blocks and already round-tripped byte-identically. The reader and the
writer both already tolerated the shape. What was missing was `entryDocumentToMarkdown` ever choosing
to *write* it for an empty paragraph, and `blocksToPM` ever choosing to *read* it back as one.

Two halves, both in `entry-document.ts`:

- **The writer** emits the marker for a genuinely empty paragraph — but only when that paragraph has a
  sibling. An untouched Composer is itself a single empty paragraph, and an empty Entry must keep
  writing `""` rather than acquiring a character.
- **The reader** turns a prose run whose entire content is the marker back into a genuinely empty
  paragraph. The marker never reaches the document as text a person could put a caret behind and
  wonder about.

**Normalization is a whole-line rule, not a substitution.** `normalizeBodyForPlainText`
(`packages/core/src/export/day-file.ts`) and `normalize_body_for_plain_text`
(`server/src/harness/tools/mod.rs`) each map a line that is *exactly* the marker to an empty line. A
no-break space is legitimate content inside a sentence — "10 km", a name that must not wrap — so a
blanket replace would be quiet data loss. The two implementations are kept in step by hand, as the
em-space rule beside them already is; they cannot share a function across languages.

## Alternatives considered

**An ordinary space.** Rejected on the CommonMark rule above: a line of only spaces is blank by
definition, so this would encode the blank line as nothing at all.

**U+2003 EM SPACE**, reusing Tab's own marker. This was the cheapest option and was seriously
considered — it needs no new normalization at all, because both boundaries already strip em spaces.
Rejected because it would make a deliberate blank line and a Tab-only line the same bytes, collapsing
two different intents into one spelling and leaving neither recoverable.

**U+200B ZERO WIDTH SPACE.** Survives the round trip equally well and can never be mistaken for a
typed space. Rejected for that same property: it is invisible in every diff, editor and terminal, and
this branch's own code review had already caught one invisible byte as a defect. A no-break space at
least renders as a space.

**A backslash-only line.** Probed and rejected on evidence: the writer escapes it to `\\`, so it does
not survive the round trip at all.

**Storing HTML, as UpNote does.** Ruled out by 0069, which is a decision about the storage format, not
about this keystroke.

**Doing nothing and recording the divergence.** The honest fallback, and what 0069 effectively chose
by deferring. Rejected now only because the encoding turned out to cost two call sites and one
whole-line rule, which is cheap enough that accepting a permanent visible gap against UpNote is no
longer the better trade.

## Consequences

**Export.** A blank line exports as a genuinely blank line in the `.txt`. `renderDayFile` does no
continuation indenting, so there is no residue.

**LLM prompts and the Digest.** The Server's own renderer indents every line after the first by two
spaces (`indent_continuation_lines`), *including* a blank one — its doc comment states this outright,
so "the boundary rule has no silent exception". A deliberate blank line therefore reaches a model as a
line of exactly two spaces. **This is not new and is not a regression**: an ordinary `\n\n` block break
already produces exactly the same two-space line, and has since #151. The point of the whole-line rule
is that a deliberate blank line arrives looking identical to the blank line a block break already
produces, rather than as a stray no-break space a model would have to guess the meaning of. Asserted
directly in `render_entry_renders_a_deliberate_blank_line_like_an_ordinary_block_break`, because a
line of two spaces looks like a mistake until you know it predates this decision.

`digest.rs`'s own `render_entry` reuses `harness::tools::normalize_body_for_plain_text` rather than
keeping a copy, so the Digest path is covered by the one change.

**Search.** Both indexes stay raw (0069's decision 5), so a phrase search spanning a blank line does
not match — the same limitation a hard break already carries, for the same reason, extended to one
more shape. Not fixed here.

**Reader tolerance is permanent, and there is no migration.** A body written before this decision has
no marker, so it reads exactly as it always did: a run of newlines still collapses to a single block
break. This is not a transitional kindness. A Restore reinjects old data shapes indefinitely
([0064](0064-a-backup-is-a-sql-dump-restore-replaces-and-merge-folds-in.md)), so "every body has been
migrated" is a state this app can never actually reach, and the tolerance is a permanent property
rather than a step on the way to removing it.

**A keystroke test must write what it reads.** Asserting that a live document's stored form reads
back to the same shape is what catches an encoding that renders correctly but cannot be written down
and read back. That assertion immediately found a pre-existing defect unrelated to this ADR: a
checkbox's mandatory separator space survives into the Composer's load path as real text. Filed
separately.

**A blank line is now expressible, so it can be typed by accident.** Two Enters have always been easy
to press. They previously collapsed silently; now they persist. This is the intended behaviour and
matches UpNote, but it does mean a body can carry blank lines a person did not deliberately want, and
nothing strips them.
