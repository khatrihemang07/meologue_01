# 0069: Enter splits a block, Shift+Enter is a soft break

## Status

Accepted. **Supersedes [0066](0066-enter-is-a-soft-break.md)**, whose keystroke-level fix (Enter
inserts a literal `\n` instead of splitting the paragraph) this ADR reverses; that ADR's own
diagnosis of the symptom it was written for is not wrong, and is restated rather than redone in
Context, below — what changes is the layer the fix lives in. Builds on
[0043](0043-an-entry-may-carry-structure.md)'s block grammar and the reader's own `collectBlocks`
(inline-markdown.ts, issue #152). Issue #232's own first landing extended it with a second,
display-only collector rather than changing it in place — Decision's own account, below, still
describes why editing it in place was tried first and abandoned at that point. **Issue #234's own
landing converged the two back into one**, once the writer changed too (Decision's own amended
account, below, has the reasoning the original attempt was missing): `collectBlocks` is the single
collector every reader in this app uses, `entryDisplayParser`/`parseEntryMarkdownForDisplay`/
`collectDisplayBlocks` no longer exist, and the "second parser" framing this ADR originally shipped
with is now historical, kept in Decision's own account rather than deleted, because it is the
reasoning a later reader needs to understand why the writer had to change at the same time. Extends
[0072](0072-upnote-is-the-specification-per-input-modality.md)'s
stance that UpNote's own observed behaviour, not a claim written once into an ADR's prose, is what
"feels like UpNote" has to answer to — this ADR is the case that stance was written for:
`docs/reference/upnote-editor-behaviour.md`'s byte-verified record of UpNote's own block model is
the concrete fact 0066 did not have when it reasoned its way to a different design.
[0073](0073-editor-parity-is-proved-by-a-generated-matrix.md)'s parity fixture
(`apps/web/src/lib/parity/parity-fixture.ts`) now carries this ADR's own target rows for the
Composer's document model. Reuses [0041](0041-prose-renders-as-inline-markdown-at-render-time.md)'s
`white-space: pre-wrap`, unchanged in mechanism, retargeted in purpose — see Decision. Names
[0067](0067-a-one-time-pass-halves-old-newline-runs.md)'s own migration historical rather than
superseding it — that pass still runs, still does exactly what it always did, and simply stops
being the thing standing between a legacy body and the defect it was written to prevent; see
Consequences.

This ADR was written as a two-ticket decision, and both tickets have now landed. Issue #232 (the
reader — `entryProse`, entry-prose.tsx; the parser, inline-markdown.ts) implemented everything that
did not touch `entryDocumentToMarkdown`'s writer or the Composer's keymap, landing the
display-only-parser shape Decision's own account below still describes as the FIRST attempt. Issue
#234 (the editor — `insertSoftBreak`/`splitBlock` and the keymap, composer-commands.ts/
composer-editor.ts) implemented the rest — Enter actually splits a block, Shift+Enter actually
writes a backslash hard break — and, in doing so, changed the writer (`escapeUserText`/`writeBlocks`,
entry-document.ts) enough to retire #232's own display-only parser and converge back onto a single
`collectBlocks`. Both halves are therefore now live: Enter splits, Shift+Enter soft-breaks, in prose
and inside a list item, and `entryMarkdownToDocument` (the Composer's load path) and `entryProse`
(History's read path) see the identical block/soft-break shape for the same stored body.

## Context

**This is the reported defect ADR 0066 was written for, restated because this ADR's own account of
it differs on one point.** Pressing Enter once in the Composer rendered as a blank line. ADR 0066
traced this correctly to a genuine seam: `entryDocumentToMarkdown`'s writer cannot spell "two
paragraphs, no gap" as two block nodes in Markdown at all — CommonMark reads a lone `\n` between two
lines of prose as a lazy continuation, folding the second line back into the first, so the writer is
*forced* to insert a real blank line (`\n\n`) to make a paragraph split survive being written down
and read back at all. `collectBlocks` then merged the resulting two paragraphs back into one prose
run specifically so that forced `\n\n` would render as the single line break it was meant to be,
rather than the blank line CommonMark would otherwise insist it means. ADR 0066's diagnosis was
right: this is a genuine collision between what CommonMark can express and what one keystroke should
look like. What was wrong was the conclusion it drew from that collision — that Enter itself had to
stop splitting the block.

**UpNote's own mechanism for the identical problem was sitting in this repo the whole time, unread
until this ticket.** `docs/reference/upnote-editor-behaviour.md`, produced by driving the shipped
application by hand and reading its stored HTML back byte for byte, records the actual answer under
"The one fact that explains the reported defect": UpNote's block element is a bare `<div>`, whose
default margin is zero. Its inter-block gap is therefore exactly one line-height — one Enter looks
like one new line not because Enter avoids creating a new block, but because the block boundary
itself costs nothing extra to look at. `alpha` Enter `bravo` is stored, verified against the actual
`upnote.sqlite3`, as `<div>alpha</div><div>bravo</div>` — two real sibling blocks — and `alpha`
Shift+Enter `bravo` is stored as `alpha<br>bravo` — one block, a line break inside it. UpNote never
had ADR 0066's problem, because it never collapsed those two into the same operation to begin with;
the "problem" ADR 0066 solved by redefining Enter was, in UpNote's own model, never actually a
consequence of what Enter means. It was only ever a consequence of what a Markdown paragraph
boundary is forced to cost in the one dialect this app happens to store.

**Collapsing block break and soft break into one concept is what left Shift+Enter with nothing
distinct to do, and that is the defect actually being reported now.** `isSubmitChord` excludes any
Shift-held Enter before either keymap is reached, so under ADR 0066's model, plain Enter and
Shift+Enter are bound to the identical chain — `insertSoftBreak` — because there was only ever one
concept left for either of them to invoke. A person who reaches for Shift+Enter expecting a
different result to plain Enter, the way UpNote and essentially every other editor with both keys
bound behaves, gets exactly what plain Enter would have given them. That asymmetry — one keystroke
with two names and one behaviour — is what a user reported, and it is a direct, structural
consequence of ADR 0066's fix, not an unrelated gap in it.

**Storage stays Markdown, which is the reason this ADR's own encoding decision exists at all.**
ADR 0043 already inspected UpNote's shipped bundle and found it stores HTML directly in SQLite,
which is exactly what buys it a free-form `<div>`/`<br>` distinction with no serialization to worry
about. That ADR kept this app on Markdown anyway — Export, Sync and the Digest all read the same
characters a body is stored as — and said plainly that doing so "pays for it elsewhere." This ADR is
where a piece of that bill comes due: Markdown has no native "zero-margin div," so the block/soft
distinction UpNote gets for free has to be spelled out in the stored text itself, in a form that
survives being read by every one of those other consumers.

## Decision

**The model: Enter splits a block; Shift+Enter is a soft break that stays inside one.** This is
UpNote's own model, adopted directly rather than reasoned toward independently — `alpha` Enter
`bravo` becomes two sibling blocks with no gap between them; `alpha` Shift+Enter `bravo` becomes one
block containing a line break. The keystroke half of this (composer-commands.ts's keymap, the
`splitBlock`/`insertSoftBreak` chain) belongs to issue #234, not this ticket, and this ADR does not
implement it. What this ADR's own ticket (#232) implements is the other half: given a stored body
that already contains one of these three newline shapes — written under this model, under ADR
0066's superseded one, or under nothing at all, since Restore can reinject any of them indefinitely
— render it as this model says it should look.

**The soft break is encoded as GFM's own backslash hard break — `\` immediately before `\n` — not a
private syntax invented for this app.** It is real, existing Markdown: legible in any other tool
that reads this dialect, and `@lezer/markdown`'s own `HardBreak` inline parser already recognises it
(and, as a side effect of using the built-in parser rather than a hand-rolled one, two-or-more
trailing spaces before `\n` — GFM's other hard-break spelling, harmless to leave enabled since
nothing in this app writes it and no stored body sampled while building this ticket contained one).
The backslash itself carries no meaning of its own once recognised — `walkEntryInline`'s own
`"HardBreak"` case (inline-markdown.ts) drops it and pushes a bare `\n` character in its place, not
a dedicated node kind: every surface `entryProse` renders through already keeps `white-space:
pre-wrap` on an ancestor element (ADR 0041's own mechanism, retargeted here rather than replaced),
so a literal `\n` inside one block's own text already renders as one visual line break with no
`<br>` element and no new mark kind for `inline-prose.tsx`'s shared `renderNodes` to learn.

**A bare `\n` is a block break, and `\n\n` is the identical block break, not two.** `collectBlocks`
and its own `pushProseRuns` helper (both inline-markdown.ts — issue #232 first landed this pair as
the display-only `collectDisplayBlocks`; issue #234 converged it back onto `collectBlocks` itself,
per Decision's own account above) stop merging consecutive `Paragraph`/`Task` siblings back into one
prose run, and additionally split a single `Paragraph` node's own text at every embedded bare `\n` —
the lazy-continuation newline CommonMark leaves sitting inside one merged paragraph when nothing
marks it as a hard break. Critically, this collapses any *run* of bare newlines to exactly one block
boundary: CommonMark's own block parser already treats a blank line (`\n\n` or longer) as a single
paragraph boundary, consuming the run entirely as the gap between two `Paragraph` siblings rather
than handing either of them a character count to distinguish "one Enter" from "two." A stored body
carries no reliable signal for how many blank lines its author meant, once that count could come from
either a deliberate gap or a forced separator nobody chose (ADR 0066's own Context) — so this ADR
stops trying to recover it, and renders every non-empty run of bare newlines identically: one
boundary, one line-height, nothing more. `pushProseRuns`'s own scan is what makes this safe rather
than lossy for a genuine paragraph's own leading indentation: it threads a running cursor across
every child in its own container, rather than trusting a `Paragraph` node's own `.from` — which
silently skips leading whitespace on its first line, the identical swallowing `itemContentStart`'s
own comment already named for a list item's marker — so real, typed indentation on a line that
follows a blank line survives intact rather than being read as separator.

**Issue #232's own landing had to become a second parser and a second pair of collector functions,
never an edit to the existing ones — and issue #234's landing converged them back into one, once the
hazard that forced the split in the first place was worked through to the end rather than stopped at.**
#232's first attempt edited `collectBlocks`/`entryParser` in place. It passed every unit test for the
reader and broke `soft-break-migration.test.ts` (ADR 0067) — twenty-four failures, none of them
touching inline-markdown.ts or entry-prose.tsx directly. The reason: `parseEntryMarkdown` is not only
the reader's own entry point, it is `entryMarkdownToDocument`'s (entry-document.ts) — the Composer's
own load-a-body-for-editing path — and `blocksToPM` builds exactly one ProseMirror `paragraph` node
per `"prose"` `EntryBlockNode` `collectBlocks` hands it. Splitting a merged prose run into several
would have changed that paragraph count for any stored body containing a bare `\n`, and the
THEN-unchanged writer downstream of it (`writeBlocks`, entry-document.ts) inserted a forced `\n\n`
ahead of any genuine paragraph sibling that did not already begin with its own leading `\n`. Two real
siblings split from what was one merged run, from a single `\n`, would therefore have written back
out as `\n\n` — doubling every bare newline in a body the moment the Composer opened and re-saved an
Entry nobody actually edited, reintroducing, with no keystroke involved at all, the exact defect ADR
0066/0067 exist to have fixed. #232 stopped there, at its own file-ownership boundary: it added
`entryDisplayParser` (a second `commonmark.configure()` call, identical to `entryParser` except
`HardBreak` left enabled), `collectDisplayBlocks`/`pushProseRuns`, and the exported
`parseEntryMarkdownForDisplay`, beside `entryParser`/`collectBlocks`/`parseEntryMarkdown` rather than
editing them, with `entryProse` (entry-prose.tsx) the only caller of the new, display-only pair —
leaving History and the Composer disagreeing about the shape of the same body (a two-block Entry in
History read back as one soft-broken paragraph on Edit) until the ticket that owned the writer landed.

**#234 is what closed that gap, by finishing the reasoning #232's own hazard paragraph left half
worked-through.** The hazard was real only as long as the writer stayed unchanged; #234 changes the
writer too (`escapeUserText`, entry-document.ts — every embedded `\n` in a text leaf now escapes to
`\` + `\n` unconditionally, and `writeBlocks`'s paragraph-sibling separator is unconditional `\n\n`,
no longer gated on a leading-`\n` check that made sense only under the pre-#234 model), which makes
the doubling hazard provably NOT reachable any more: `entryDocumentToMarkdown(entryMarkdownToDocument(body))`
is a genuine fixpoint for a body already shaped this way (`"a\n\nb"` → `[p(a), p(b)]` → `"a\n\nb"`),
and a legacy body shaped under ADR 0066's old model changes its bytes exactly ONCE on the first
re-save (`"a\nb"` → `[p(a), p(b)]` → `"a\n\nb"`) and stays a fixpoint from then on —
`CONTEXT.md`'s own Entry definition already permits an edit normalising a body's formatting, and
`entry-document.test.ts`'s 691-case round-trip corpus is the proof this reasoning holds, not merely
the assertion that it does. With that hazard resolved, the reason #232 had for a second parser no
longer applies: `entryDisplayParser`, `collectDisplayBlocks`, and `parseEntryMarkdownForDisplay` are
deleted outright, `collectBlocks` (renamed from `collectDisplayBlocks`, its own splitting logic
intact) and `entryParser` (with `HardBreak` now enabled permanently) are the ONLY collector and
parser in inline-markdown.ts, and `entryProse` calls the exact same `parseEntryMarkdown` that
`entryMarkdownToDocument` does. History and the Composer no longer have two different readers to
possibly disagree with each other at all.

**A block boundary costs exactly one line-height, matching UpNote's own zero-margin `<div>`.**
`BLOCK_SPACING` (entry-prose.tsx) changes from `"first:mt-0 mt-1"` to `"mt-0"`, applied to every
block — a `"prose"` `<p>`, a `<ul>`, an `<ol>` — not only the first. `mt-1` was the extra gap a block
boundary used to add on top of the line break every sibling already got from sitting on its own
row; removing it is the entire mechanism this ADR borrows from UpNote, and it is why splitting a
merged paragraph into several real blocks does not, on screen, look any different from the single
`pre-wrap` paragraph it replaces — each already-wrapped line still occupies exactly one line-height,
whether that line-height comes from a literal `\n` character or from a zero-margin sibling element.
This was checked directly against real journal data (a Device's own Sandbox corpus and Production
History, not synthetic strings): entries written as continuous, later hard-wrapped prose render
identically to before, one line per row with no added gap; the one genuine `\n\n` found in real
Production History — a note written under the pre-0069 model, forced into a blank line by the exact
mechanism this ADR's Context describes — now renders as a plain block boundary with no blank row,
which is precisely the fix this ADR exists to make visible.

**`whitespace-pre-wrap` collapses to one owner per surface as a prefactor, ahead of the parsing
change, with no behaviour change of its own.** It was previously set independently in three places —
`entry-prose.tsx`'s own `"prose"` `<p>` (and `defaultTaskReferenceItem`'s label `<p>`),
`entry-row.tsx`'s `EntryBody` wrapper, and `entry-bubble.tsx`'s bubble-body wrapper — all three
redundant with each other, by that code's own prior comments. `white-space` is an inherited CSS
property, so the fix is to stop repeating it on every leaf element `entryProse` generates
(`entry-prose.tsx`'s own `<p>`s, and `entry-row.tsx`'s `TaskReferenceItem`, which sits beside them in
the same tree) and keep it only on each surface's own outermost wrapper — `EntryBody` and the bubble
body never coexist in the same render tree, so each is its own surface's single owner rather than
two competing ones. This step alone was verified to change nothing on screen before the parsing
change landed on top of it, which is what made the parsing change, in turn, a one-place edit.

**A bare `\n` is tolerated as a block break forever, not as a transitional kindness.** ADR 0064's own
Restore replaces a Device's data wholesale from a Backup file, and a Merge folds one in — both can
reintroduce a body shaped by any build this app has ever shipped, indefinitely, on any future date.
ADR 0067's own migration already accepted a version of this permanently (a stale pre-0066 client
past its own cutoff; clock skew stamping a post-cutoff `updated_at` on a pre-cutoff body — both named
explicitly in that ADR's own Consequences) and it is a *one-time*, per-row pass: nothing about it
re-arms against a body a Restore reinjects after that row was already judged past its cutoff. A
migration cannot retire an ambiguity that a Backup file can resurrect at any later date; only the
reader can, by rendering both possible histories of a bare `\n` — a fresh Enter under this ADR's own
model, or an unmigrated (or never-to-be-migrated) Enter under ADR 0066's — identically. That
identity is exactly what collapsing every non-empty run of bare newlines to one block boundary
already buys: a legacy body still carrying `\n\n` for what was always a single old Enter renders no
differently than a body that was always a single `\n`, whether or not ADR 0067's pass ever reaches
it.

## Consequences

**A deliberately authored blank line still cannot be told apart from the same defect this ADR fixes,
and #234 did NOT close this gap — it remains open, past both tickets this ADR names.** Two soft
breaks typed in a row under ADR 0066's own model produced `\n\n` inside one merged paragraph —
indistinguishable, once written to storage, from the forced separator ADR 0066's own Context
describes. This ADR renders both identically: a single block boundary, no blank row. A body that
genuinely wants a visible blank line — two adjacent block boundaries, nothing (not even a soft
break) between them — still has no way to ask for one: the Composer's own `splitBlock`/
`insertSoftBreak` chain (#234, composer-editor.ts) can produce the live ProseMirror shape for it
(`doc(p("alpha"), p(""), p("bravo"))`, an empty paragraph sibling — reachable today by pressing Enter
twice), but `entryDocumentToMarkdown` has no way to write that shape back out as anything other than
`"alpha\n\n\n\nbravo"`, and `collectBlocks`'s own "any non-empty run of bare `\n` is exactly one
block boundary" rule (Decision, above — deliberately not run-length-aware, per the finding recorded
in `soft-break-migration.test.ts`) reads that straight back as two blocks, not three: the middle
empty one does not survive a Send. This was considered directly while implementing #234 and set
aside rather than solved — the fix would need a NEW encoding (something CommonMark itself has no
native way to spell as "an empty block between two others," since a blank line is definitionally the
absence of content, never content of its own) with no existing test, fixture row, or acceptance
criterion asking for one. Nothing before this ADR could express "no gap" either, so no existing
capability regresses; this stays an accepted, open gap, not a regression, and not something either
ticket this ADR names actually closes — a future ticket, not yet filed, is where it belongs.

**ADR 0067's one-time halving pass is now historical rather than load-bearing — and, after #234's own
landing, provably a no-op for every body it can actually reach, not merely unnecessary.** It still
runs exactly as before, still walks `entryMarkdownToDocument(body)` looking for an even run of
newlines inside a top-level `paragraph` leaf, and its own invariant — it only ever removes `\n`
characters — still holds; nothing about this ADR touches its code, and retiring it outright is out
of scope for this ticket. What changes is that `entryMarkdownToDocument` itself (via #234's own
converged `collectBlocks`) now splits at every bare `\n` boundary BEFORE that walk ever runs, so a
top-level paragraph leaf built through the real parser can no longer hold an "old Enter" run at all
— it was already consumed as a block boundary between two sibling paragraphs. `soft-break-migration.test.ts`'s
own `"equals the plain round trip for every case in this file"` test (added by #234) is the direct
evidence: `halveSoftBreakRuns(body) === entryDocumentToMarkdown(entryMarkdownToDocument(body))` for
every body that test suite constructs, and `halveSoftBreaksInHistory` consequently reports
`rewritten: 0` for every Entry it now scans, not merely for the ones already migrated. The pass
remains correct — its own primitive, `halveDocument`, still correctly halves a HAND-BUILT document
carrying the old shape, which is what its own remaining unit tests exercise directly, since nothing
built through the real parser can produce that shape for it to act on any more — and remains safe to
leave running (a body a Restore reintroduces still passes through it harmlessly); it has simply
stopped being able to do anything at all, which is a stronger claim than ADR 0069's original
"stops being load-bearing."

**Glossary terms are still owed to `CONTEXT.md`, and still not paid — by either ticket this ADR
names.** Issue #232's own acceptance criteria name three: block break, soft break, and the hard break
encoding. `CONTEXT.md` was outside issue #232's file ownership when that was written, and stayed
outside issue #234's: `CONTEXT.md` is explicitly owned by the project maintainer, not by an agent
landing this ticket, so #234 does not amend it either, despite being the ticket where the hard-break
encoding this ADR names actually starts being written. This is a real, acknowledged debt, not an
oversight this ADR fails to notice — following ADR 0057/0067's own precedent of amending the
glossary alongside the change that makes an old entry there stop being quite true is still the right
call, whenever it is made by whoever holds that file's own pen.

**The Composer's own load/save round trip does carry a real, deliberate change from #234's own
implementation — the opposite of what this ADR originally claimed for issue #232 alone.** That
original claim was true for #232's own landing: `entryMarkdownToDocument`/`entryDocumentToMarkdown`
were byte-for-byte unchanged by it, precisely BECAUSE #232 built a second, display-only parser rather
than touch them. #234 is the ticket that changes them on purpose — that is the entire mechanism that
converges History and the Composer onto the same reader (Decision, above) — so "no new risk" has to
be re-argued, not merely re-asserted: `entry-document.test.ts`'s 691-case round-trip corpus and the
full, rewritten `soft-break-migration.test.ts` suite both stay green, but with genuinely different
expected OUTPUT strings than before #234 (a legacy body's blank-line artifacts now normalise via the
plain round trip itself, not via a separate migration pass — see the paragraph on ADR 0067's pass,
above) — the risk this sentence is actually about is the DOUBLING hazard #232's own Decision section
found and stopped at, and that hazard is what #234 worked through to a fixpoint (Decision, above),
not a claim that nothing changed.

## Alternatives considered

- **Keep extending ADR 0067's migration-based approach — normalise newline runs on more triggers, or
  more aggressively.** Rejected in Context and Decision above: a Backup can reintroduce any
  pre-change shape at any later date (ADR 0064), so no migration, however often it runs, can retire
  an ambiguity the reader itself has to tolerate regardless.
- **Store HTML instead of Markdown, matching UpNote's own persistence.** Rejected on ADR 0043's own
  reasoning, unchanged: Export, Sync and the Digest all read a body's stored characters directly, and
  0043 already chose to "pay for" staying on Markdown elsewhere rather than take on a second
  representation. This ADR's backslash encoding is exactly that payment, not a reason to reopen the
  choice.
- **Edit `collectBlocks`/`entryParser`/`parseEntryMarkdown` in place instead of adding a
  display-only parser and collector pair.** Tried first BY ISSUE #232, and reverted at that point
  after it broke `soft-break-migration.test.ts` — Decision's own account of the coupling this
  surfaced is the reason, not a preference. This is no longer this ADR's own final shape: issue #234
  came back to exactly this alternative once the writer could change too, found the coupling no
  longer held, and landed it — Decision's own amended account, above, has the reasoning. Kept here,
  rather than deleted, as the record of why it was rejected the FIRST time a ticket tried it, which
  is real information for whoever next considers editing a collector in place under a coupling
  assumption that may, by then, no longer hold either.
- **A dedicated `lineBreak` `InlineNode` kind, rendered as an explicit `<br>`, instead of a literal
  `\n` text character.** Rejected: it would have required teaching `inline-prose.tsx`'s shared
  `renderNodes` — a file outside this ticket's own ownership, and shared with every non-Entry prose
  surface — a fourth mark kind, for exactly the behaviour an inherited `white-space: pre-wrap`
  already provides for free.
