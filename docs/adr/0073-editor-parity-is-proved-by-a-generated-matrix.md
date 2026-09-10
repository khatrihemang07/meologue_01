# 0073: Editor parity is proved by a generated matrix

## Status

Accepted. Builds on [0072](0072-upnote-is-the-specification-per-input-modality.md), which says what
counts as UpNote's own observed behaviour and where this repo diverges from it on purpose — this ADR
is the mechanism that proves the claim, not the policy behind it. Builds on
[0044](0044-the-composer-holds-a-document.md)'s own "Tests" section, whose "jsdom cannot usefully
mount a live `EditorView`" finding is why this ticket's own replay suite lives in `apps/e2e`, not
beside `entry-document.test.ts`. Consumes `entry-schema.ts`/`entry-document.ts` (issue #154) exactly
as `entry-document.test.ts`'s own `CORPUS` does, adding no third representation of an Entry's body
alongside the two ADR 0043 already named.

## Context

Issue #230's own brief is explicit that the acceptance mechanism this ticket replaces was "reasoning
written into a comment" — the pattern ADR 0072's Context section traces across ADRs 0043, 0044,
0045 and 0066, each of which inspected UpNote once, at the moment of writing, and recorded the
result as prose. Prose has three properties that made it the wrong mechanism for this, once there
were enough decisions leaning on it to notice: it cannot be re-run after the next change to either
app, it gives no per-keystroke pass/fail signal (an ADR's paragraph is right or wrong as a whole, not
checkable claim by claim), and — the one this ticket's own name responds to most directly — a
reader has no way to tell, from the prose alone, whether "matches UpNote" was checked against the
UpNote UpNote actually ships or against what the author remembered UpNote doing.

A second, narrower problem sits underneath the first: two representations of the same visible
document look nothing alike at the tree level. This repo's own `entry-schema.ts` nests a sub-list as
a CHILD of the `list_item` it belongs to (`list_item: "paragraph block*"`); UpNote's own stored HTML
nests it as a SIBLING of the `<li>` — `<ul><li>one</li><ul><li>two</li></ul></ul>`, invalid per the
HTML spec, verified directly as what UpNote's shipped editor actually writes
(`docs/reference/upnote-editor-behaviour.md`). Diffing either tree against the other directly would
report a nesting-shape mismatch on every single list in the fixture, whether or not the two documents
mean the same thing to a reader — noise loud enough to bury the two real defects this ticket exists
to surface.

## Decision

**A canonical form normalizes both trees to the same shape before anything is compared.**
`apps/web/src/lib/parity/canonical.ts` defines one structural type — an ordered list of blocks, each
either a flat run of prose (lines joined by a `"block"` or `"soft"` break, the exact distinction ADR
0066 turns on) or a list (items flattened to their own `level` integer rather than left nested,
however their own source tree happened to spell "nested") — and two adapters into it:
`entryDocumentToCanonical`/`entryMarkdownToCanonical` for this repo's own `entrySchema` document, and
`upnoteHtmlToCanonical` for UpNote's own stored HTML, read with a small dependency-free tag reader
rather than a browser `DOMParser` (which does not exist as a global in the plain Node.js process
Playwright's own test runner uses, only under vitest's `jsdom` environment — this module has to run
correctly in both). Both adapters were checked directly against each other, not merely asserted to
agree: `entryMarkdownToCanonical("- one\n  - two\n    - three")` and
`upnoteHtmlToCanonical("<ul><li>one</li><ul><li>two</li><ul><li>three</li></ul></ul></ul>")` produce
byte-identical `CanonicalDocument` values, the property this whole module exists for, not an
incidental one.

**A generated matrix, not a hand-written one, so the doc and the suite cannot drift apart.**
`apps/web/src/lib/parity/parity-fixture.ts` is the single source of truth — a typed `PARITY_FIXTURE`
array, following `entry-document.test.ts`'s own `CORPUS` convention rather than a JSON file (this
repo has no JSON-fixture precedent to follow instead). `apps/web/scripts/generate-parity-doc.mjs`
renders it into `docs/reference/composer-parity.md`; `apps/e2e/tests/composer-parity.spec.ts` reads
the SAME array and replays it against a live Composer. Editing a row's `expected`/`upnote` value
changes what BOTH the doc and the suite say, in the same commit, because there is only one place
either of them could have come from. There is no repo precedent for generating a Markdown doc from
data at all; the generator is deliberately the simplest thing that could do this — read the array,
render each row as a small section, write the file, no templating engine, no partial regeneration.

**Each row's `expected` is built directly, as a literal value, not derived by round-tripping
through `entryMarkdownToCanonical`.** This was a considered choice, not a convenience: checking
`entryMarkdownToCanonical("- [x] task")` directly against this fixture's own needs surfaced a real
quirk in `parseEntryMarkdown`'s own GFM `TaskList` handling — the STORED-MARKDOWN reading path
leaves a stray leading space in the item's text that the LIVE keystroke path (`composer-editor.ts`'s
own `checkboxInputRule`, which consumes its matched range including the trailing space) does not.
The two are genuinely different code paths reading genuinely different input, and a fixture whose
`expected` values came from the markdown-parsing path would have silently inherited that path's own
quirks into an assertion about the KEYSTROKE path — exactly the kind of mismatch this ticket exists
to catch, not to reproduce by accident in its own fixture. `upnote` values, by contrast, DO go
through `upnoteHtmlToCanonical` wherever a literal HTML citation exists, copied verbatim from the
gap-sweep tables, so a row's citation and its assertion are the same text there is nothing to drift
between.

**The replay suite lives in `apps/e2e`, keyboard-only, and reads the live document through
ProseMirror's own internal `pmViewDesc`.** jsdom cannot mount a live `EditorView` at all (ADR 0044's
own "Tests" section — no `Range`, no `Selection`, no meaningful `getBoundingClientRect`), so a
keystroke replay has no vitest-side seam to run through, the identical reasoning that already sent
every other real-typing test in this repo (`composer.spec.ts`) to Playwright. `composer-parity.spec.ts`
reuses `composerField`/`pressSequentially` from `apps/e2e/tests/helpers.ts` unchanged — `.fill()`'s
bulk DOM write bypasses the `beforeinput`/`handleTextInput` path every input rule in this Composer is
built on (helpers.ts's own comment on `sendEntry`, verified live: a `.fill()`'d `**bold**` stays four
literal asterisks). There is no exported hook anywhere in `composer.tsx` that hands a test the live
`EditorView`'s own document, and adding one was out of this ticket's own file-ownership scope besides
being new API surface on a component for a test's sake alone — so this suite reads
`composerField(page)`'s own DOM element's `.pmViewDesc.node` instead, the exact expando property
`prosemirror-view`'s own `ViewDesc` constructor sets on every DOM node it manages (`dom.pmViewDesc =
this`), the same undocumented-but-real property inspection tools built for ProseMirror already rely
on. `.toJSON()` on that node crosses the page/Node.js boundary as plain data; `entrySchema.nodeFromJSON`
rebuilds a real `Node` on the Node.js side, and `entryDocumentToCanonical` runs against that —
the SAME function `entryMarkdownToCanonical` calls for every markdown-sourced row, not a third,
DOM-shaped adapter invented for the browser side alone.

**This ticket lands red on purpose, and stays that way until a later ticket fixes the underlying
behaviour.** A row with `divergence: "none"` is a live claim that `expected` — the target UpNote's
own observed behaviour names — IS what this Composer currently produces. Two rows currently fail it:
Shift+Enter inside a list item still splits into a new item instead of inserting a line inside the
current one (`shift-enter-in-bullet-item-is-soft-break-not-new-item`,
`shift-enter-in-checkbox-item-is-soft-break-not-new-item`), and Tab on a list's first item falls
through to native focus navigation instead of nesting the item, because `sinkListItem` has no
preceding sibling to sink under (`tab-on-first-item-of-list-also-nests`). Making either of those
green belongs to a ticket that changes `composer-editor.ts`'s own keymap, not to this one, whose own
acceptance criterion is that the suite REPORTS the gap accurately, not that it closes it.

**Rows this suite cannot drive at all are still kept in the fixture, marked `replayable: false`,
and surfaced as `test.fixme` rather than silently dropped from the count.** A multi-block Tab, a
toolbar-chord list conversion, a clipboard paste — none of them reachable through
`composerField`/`pressSequentially`'s keyboard-only vocabulary, several of them (ADR 0072's own
content-losing trio) not even attempted by any code path this Composer has. Keeping the row means
the generated doc still carries its citation and its `reason`; marking it `test.fixme` rather than
omitting the row from the suite entirely means the suite's own test count still names every row the
fixture holds, rather than a reader having to cross-reference the fixture file to learn which
findings were recorded but never asserted.

## Alternatives considered

- **Diff the two document trees directly, without a canonical form.** Rejected at length in Context:
  the sibling-vs-child list nesting difference alone would report a mismatch on every list in the
  fixture, drowning the two real defects this ticket exists to surface in structural noise that means
  nothing about whether the documents agree.
- **A hand-written parity doc, checked by hand against the suite occasionally.** Rejected as the
  exact failure mode this ticket replaces — the doc and the suite are two independent artifacts the
  moment either is edited without the other, the same drift risk ADR 0072's own Context section names
  for "reasoning written into a comment" generally.
- **Build `expected` values by calling `entryMarkdownToCanonical` on hand-written markdown, the same
  way `entry-document.test.ts`'s own `CORPUS` builds its cases.** Rejected on the leading-space
  finding described above: this fixture's job is asserting what a KEYSTROKE produces, and deriving
  `expected` from the markdown-PARSING path risks silently asserting that path's own quirks instead.
- **Skip rows this suite cannot replay entirely, rather than keeping them with `replayable: false`.**
  Rejected: ADR 0072's own three content-losing citations and the two platform-split rows are load-
  bearing findings this ticket's own brief asks to be recorded, and a reader of the generated doc has
  no less a claim to them for being unable to watch a browser prove them directly.

## Consequences

**1. A future change to `composer-editor.ts`'s keymap that fixes Shift+Enter or Tab turns exactly
the two rows named above green, with no fixture edit required** — `expected` already states the
target, so fixing the behaviour is what makes the assertion pass, not a second ticket updating what
the assertion checks for.

**2. `docs/reference/composer-parity.md` is now a build artifact, not a hand-maintained reference.**
Regenerating it after ANY fixture edit changes the file (`pnpm --filter @meologue/web run
generate:parity-doc`) — a reviewer diffing a fixture change should expect this file to move in the
same commit, the same way a lockfile moves alongside a dependency bump.

**3. The suite's own honesty depends on nobody editing a row's `expected` to match today's actual
output instead of the cited target.** Nothing in the fixture's own types prevents this — a
`divergence: "none"` row asserting today's behaviour instead of UpNote's own observed one would pass
for the wrong reason, quietly turning a real gap back into "reasoning written into a comment" one
field at a time. This is a discipline this ADR names rather than a property the code enforces; a
future reviewer checking a fixture-only diff against its own `source` citation is the actual guard.

**4. Two verified quirks now have a permanent, citable home instead of living only in this session's
own gap-sweep transcripts.** The markdown-vs-keystroke leading-space difference for `- [x] `, and
the D5/composer-editor.ts tension over what Backspace should restore right after a marker fires —
both are now named in `parity-fixture.ts` itself, with the disagreement stated plainly rather than
resolved by picking a side this ticket was not asked to pick.
