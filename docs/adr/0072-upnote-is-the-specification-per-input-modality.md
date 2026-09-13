# 0072: UpNote is the specification per input modality

## Status

Accepted. Builds on [0043](0043-an-entry-may-carry-structure.md), [0044](0044-the-composer-holds-a-document.md),
[0045](0045-recognition-may-exceed-emission.md) and [0066](0066-enter-is-a-soft-break.md) — the four
ADRs that gave the Composer its block grammar, its ProseMirror document, its recognition/emission
asymmetry, and its soft-break keymap, each of them citing UpNote directly as the shipped application
this Composer's editing model was built to feel like. This ADR does not reverse any decision those
four made; it names, for the first time, what "feel like UpNote" is actually allowed to mean once
UpNote's own observed behaviour stops being flattering. [0073](0073-editor-parity-is-proved-by-a-generated-matrix.md)
is the other half of the same ticket (issue #230): this ADR says what the parity harness is FOR,
that ADR says how it is built and proved.

## Context

Three real defects sit behind issue #230, and all three were already known before this ticket
existed — not discovered by it. Shift+Enter inside a list item splits into a new item instead of
inserting a line inside the current one. Tab on the first item of a list falls through to native
focus navigation instead of nesting the item, because `sinkListItem` has no preceding sibling to
sink under and nothing else claims the keystroke. Both are named plainly, elsewhere in this repo,
as gaps rather than as choices: ADR 0066's own "Consequences" section, written about a closely
related keystroke, is candid that soft-break handling has an edge it does not cover; the Tab gap has
no ADR of its own at all, because nothing before this ticket compared it against anything to notice
it needed one. The third — how a nested list's un-listing behaves under repeated toggling — was
never even implemented in this Composer to compare against, since there is no multi-select toolbar
gesture here at all.

What issue #230's own brief names as the actual problem is not any one of these three. It is how
they were being verified. "Matches UpNote" has been a phrase used freely in this repo's own commit
messages, ADRs and code comments since ADR 0043 first inspected UpNote's shipped bundle — ADR 0044
built the whole case for ProseMirror partly on UpNote's own `contenteditable` architecture, ADR 0045
corrected a recognition gap by re-checking UpNote's own accepted marker alphabet, ADR 0066 justified
Shift-Enter's binding by asserting it "means what UpNote's own Shift+Enter means." Every one of those
checks was real — each ADR names exactly what was inspected and how. But none of them was load-bearing
against a *record*: each was a claim made once, in prose, at the moment a decision was written down,
never re-checked against UpNote again after that moment, and never checked systematically across the
keystrokes this Composer actually implements. A claim written into an ADR's own paragraph is not
wrong for being informal, but it cannot be regenerated, it cannot be re-run after the next change,
and it gives a reader no way to tell "verified directly" from "assumed to still hold" a year later.
Issue #230 exists to replace that mechanism, not to fix Shift+Enter or Tab — later tickets do that,
against the record this ticket creates.

Making UpNote's own observed behaviour the record, rather than this repo's own prior belief about
it, immediately surfaces cases where UpNote itself is not a target worth copying. `meologue-parity-docs/upnote-macos-detail.md`
and `meologue-parity-docs/upnote-android-detail.md`'s own gap sweeps — driven against the shipped
applications directly, not read from documentation — found three behaviours that destroy the user's
own words, and two places where the two UpNote platforms disagree with each other. Both kinds of
finding need a place to be decided on the record, which is what this ADR is.

## Decision

**UpNote is the specification, but only within the input modality it was captured on.** macOS —
driven with `osascript`/`cliclick`, read back from the literal `html` column in `upnote.sqlite3` —
is the specification for what a physical keyboard should do: Enter, Shift+Enter, Tab, Shift+Tab,
Backspace, and every input-rule marker. Android — driven with `adb input`, read back from
screenshots and structural probes (a Backspace that merges two lines proves they were one block, not
two) — is the specification for what touch and the on-screen keyboard should do, including the
toolbar buttons `upnote-editor-behaviour.md`'s own "Android" section documents as promoted
affordances (indent, outdent, soft-line-break) for gestures a soft keyboard has no keys for at all.
Neither platform is asked to arbitrate the other's own modality. Where the two disagree — nested
numbered-list markers (macOS: a plain `1.` at every level, verified at both the DOM and the pixel
level from a freshly-built all-`<ol>` structure; Android: the SAME bullet glyph cascade `◦`/`▪`
numbered lists already use, re-verified twice, independently, in this session's own gap sweeps) and
multi-line paste (macOS: newlines become `<br>` soft breaks inside ONE block, verified in
`upnote-macos-detail.md`'s own §10; Android: multiple separate blocks, confirmed structurally by a
Backspace that merges two pasted lines onto one, `upnote-android-detail.md`'s own Gap sweep #2 Group
K2) — that is not a bug in either report to be reconciled into one answer. It is recorded as a
platform split, and the fixture (`apps/web/src/lib/parity/parity-fixture.ts`) carries a `platform`
field on exactly the rows that need one, rather than forcing a single, spuriously precise "UpNote's
behaviour" onto a case where UpNote itself has two.

One split is recorded here in prose only, deliberately without its own fixture row: the ordered-list
nesting *glyph* (macOS's plain `1.` at every level against Android's bullet-glyph substitution at
levels 2+) is purely a rendering choice neither platform's own document MODEL distinguishes — both
sides agree the node is an ordered list at whatever depth it sits, and the canonical form
(`canonical.ts`) deliberately has nothing to say about marker glyphs at all, the same way it has
nothing to say about font weight. A parity row exists to compare structure; there is no structural
difference here to compare.

**Where UpNote loses content, this Composer diverges on the record rather than copying the loss.**
Three behaviours were verified as genuinely destructive, not merely surprising:

- **A multi-block Tab destroys both blocks' text.** Reproduced 2/2 on macOS (`upnote-macos-detail.md`
  Gap sweep #2 Group K1: Tab across a two-block selection deletes the selection and replaces it with
  a single U+2003 em space, confirmed by screenshot and at the hex level both times) and 2/2 on
  Android (`upnote-android-detail.md` Gap sweep #2 Group K1: the same gesture, via the toolbar indent
  button, deletes the EARLIER block's text outright and leaves the later block untouched, confirmed
  by Undo restoring it). The two platforms destroy the content differently — one collapses to a
  single em-space block, the other empties one block and spares the other — but both destroy it, and
  neither offers any warning before doing so.
- **macOS's own un-list toggle collapses three separate items into one `<br>`-joined block.**
  `upnote-macos-detail.md` Gap sweep #2 Group G3: toggling a 3-item bullet list off with the SAME
  chord that built it does not restore three plain blocks — it fuses their text into one block,
  joined by `<br>`, confirmed at the hex level. A person who built a list from three separate lines
  and un-lists it does not get three separate lines back.
- **A nested list's un-listing alternates rather than monotonically flattening.** `upnote-macos-detail.md`
  Gap sweep #2 Group I1: repeatedly toggling a 3-level nested list off does not lift one level per
  press, and does not flatten in one press either — it alternates between outdenting one level (when
  the selection is uniformly list-active) and RE-NESTING everything back to uniform (when the
  previous outdent left a mixed selection), taking five presses to reach fully flat for a 3-level
  list. This is not content loss the way the other two are, but it is a case where the naive
  expectation — "press the un-list button until the list is gone" — actively works against the
  person pressing it partway through, which this ADR treats as belonging in the same category:
  UpNote's own editing model, examined closely, is not always something worth copying.

None of these three currently has a code path to even attempt in this Composer — there is no
multi-block Tab command and no multi-select toolbar toggle here at all — so "diverges on the record"
means the parity fixture states the divergence and the reason for it explicitly
(`divergence: "deliberate"`, with `reason` naming the citation above), rather than the absence
of the feature being mistaken for an untested gap. `apps/web/src/lib/parity/parity-fixture.ts`'s
own rows for these three are marked `replayable: false` for the identical reason ADR 0073 explains
at length: this Composer's keyboard-only replay vocabulary has no way to build a multi-block
selection or drive a toolbar chord, so there is nothing here for `apps/e2e/tests/composer-parity.spec.ts`
to actually run — the row exists so the generated doc still carries the citation and the reasoning,
not because the suite asserts anything about it.

**A `divergence: "none"` row is a live claim, not a historical note.** Where this repo's own
Composer is EXPECTED to match UpNote's observed behaviour and currently does not — Shift+Enter
inside a list item, Tab on a list's first item — the fixture's `expected` value is the TARGET
(what UpNote does, per the citation), not a description of today's actual output. ADR 0073 covers
why this is what makes the suite land red on purpose rather than green by construction.

## Alternatives considered

- **Treat UpNote as one specification, resolving macOS/Android disagreements by picking whichever
  platform's finding "feels more authoritative."** Rejected: both gap sweeps are equally verified,
  against the same shipped application on two different operating systems built for two different
  input modalities. Picking one over the other would assert a fact neither sweep actually found —
  that one platform is more correct than the other — rather than the fact both sweeps DID find, that
  the platforms genuinely differ.
- **Copy UpNote's three content-losing behaviours anyway, on the theory that "matches UpNote" should
  mean matches it completely.** Rejected at length above: none of the three is a design choice
  worth preserving, each one destroys or reorders a person's own words with no warning, and this
  repo has never had a code path that could even attempt any of them — building one solely to
  reproduce a defect UpNote itself did not intend would be new, deliberately-broken surface area,
  not parity.
- **Give the ordered-list nesting glyph its own fixture row anyway, for completeness.** Rejected: the
  canonical form this harness compares against is explicitly structural (`canonical.ts`'s own module
  comment), and both platforms already agree on the structure here. A row with nothing to disagree
  about would test the fixture-writer's diligence, not the Composer.

## Consequences

**1. A future gap-sweep session that finds a FOURTH content-losing UpNote behaviour has a place to
put it that already exists.** It joins this ADR's own list above and gets a `divergence: "deliberate"`
row in the fixture with the same shape the three here already have, rather than becoming a fresh
argument about whether copying it would be correct.

**2. The two platform-split rows this ADR names in prose (nested numbered markers, multi-line paste)
are asserted where the fixture can actually assert them — the paste one has its own row
(`pasted-markdown-is-parsed-into-structure-unlike-either-upnote-platform`), citing ADR 0045's own
already-shipped choice to parse pasted GFM into structure, which was and remains the right call
independent of what either UpNote platform does with the same paste.** The numbered-marker glyph
split has no row at all, per this ADR's own reasoning above, and a reader looking for one should
find this paragraph instead, not conclude the split went unrecorded.

**3. "UpNote is the specification" is now falsifiable rather than aspirational.** Before this
ticket, an ADR could assert a Composer decision "matches UpNote" and there was no mechanism to
notice if that claim quietly stopped being true. `docs/reference/composer-parity.md`
(`apps/web/scripts/generate-parity-doc.mjs`, ADR 0073) is now that mechanism, generated from the
same fixture the replay suite runs — a claim this ADR makes about what UpNote does is either backed
by a citation a reader can follow into the gap-sweep docs, or it is not made at all.
