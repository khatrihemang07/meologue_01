# 0066: Enter is a soft break, and the line-start input rules follow it

## Status

Accepted. Reverses the Enter/Shift-Enter keymap [0044](0044-the-composer-holds-a-document.md)
recorded with reasons — see that ADR's own Status section for the specific note on what survives
and what does not. Extends [0045](0045-recognition-may-exceed-emission.md)'s "recognition may
exceed emission" line: this ADR does not touch what any rule RECOGNISES, but it does move WHERE
recognition has to look, for the identical class of rule ADR 0045 already widened once. Builds on
[0043](0043-an-entry-may-carry-structure.md)'s block grammar and the reader's own `collectBlocks`
(inline-markdown.ts), which this ADR studies closely and changes not at all. Builds on issue #210's
`splitListItemUnchecked` and issue #211's mark set, both already landed on this same keymap and
input-rule surface before this ticket touched either.

## Context

**This is the reported defect.** Pressing Enter once in the Composer rendered as a blank line, not
one new line. Two Enters produced two blank lines, not one. A person typing an ordinary two-line
Entry — `alpha` (Enter) `bravo` — got back `alpha`, a blank line, `bravo`: their Entry visibly grew a
line they never asked for, in the one surface of this app that exists to write plain, honest prose.

The mechanism was not a rendering bug; it was two entirely correct pieces of code, built on entirely
correct reasoning, meeting at a seam neither one owned. Enter, since ADR 0044, split the paragraph —
`chainCommands(splitListItem, liftListItem)`, then `baseKeymap`'s own ordinary block split outside a
list. Splitting a paragraph is not itself wrong; ProseMirror's own base keymap does exactly this for
every plain-text editor built on it. The problem is what a paragraph SPLIT has to become once it
reaches `entryDocumentToMarkdown`'s writer (`writeBlocks`, entry-document.ts). Two adjacent
paragraph siblings cannot be written with a single `\n` between them: CommonMark treats a lone `\n`
between two lines of prose as a LAZY CONTINUATION — the second line is folded back into the first
paragraph on the next parse, not read as a paragraph of its own. `writeBlocks` already knows this
(its own comment: "a lone `\n` is a lazy continuation, which the parser folds back into whatever
block sits above it") and writes `\n\n` — a genuine blank line — as the ONLY separator that survives
a round trip between two paragraph siblings. That is correct, forced by CommonMark, and not
something this ADR touches.

The other correct piece is the reader. `collectBlocks` (inline-markdown.ts) merges consecutive
`Paragraph`/`Task` siblings into ONE `"prose"` block, copying the gap between them through
VERBATIM — `walkEntryInline`'s own gap-filling (`if (node.from > cursor) pushText(result,
body.slice(cursor, node.from))`) means whatever raw characters sit between two merged paragraphs,
blank line included, become literal text in the merged run. This is also correct and deliberate:
`entry-document.test.ts`'s own 691-case round-trip corpus already depends on `a\n\n\n\nb` surviving
as the identity, and every prose surface in this app (`entry-prose.tsx`, the Composer's own
`.ProseMirror` rule) sets `white-space: pre-wrap`, specifically so a blank line preserved as
characters renders as a real blank line rather than collapsing. Two paragraphs typed with a real,
deliberate gap between them — pasted Markdown, an Entry from before this ticket — are SUPPOSED to
show that gap.

Put the two together and the defect appears exactly once, at the exact moment Enter is pressed
ONE time: split produces two paragraphs with nothing between them → the writer, forced by
CommonMark, inserts `\n\n` to make that split survive a round trip at all → the reader, correctly
merging paragraph siblings back into one prose run, renders that `\n\n` as a literal blank line. The
separator that CommonMark REQUIRES between two paragraphs is, under `white-space: pre-wrap`, THE
SAME CHARACTERS as a deliberate blank line. There is no way to write "these are two lines with
nothing between them" as two paragraph nodes; the model has only one kind of gap, and it is a blank
one.

## Decision

**The fix is at the keystroke, not in the reader.** Outside a list, Enter no longer splits the
block. `insertSoftBreak` (composer-commands.ts) inserts a single literal `\n` character into the
CURRENT paragraph — `state.tr.replaceSelectionWith(entrySchema.text("\n", marks), false)` — the same
document-editing shape any other typed character takes, dispatched as a plain transaction rather
than routed through `handleTextInput`, so it can never itself re-trigger an `InputRule` the way an
actual keystroke would. Two soft breaks in a row give `\n\n` — a genuine blank line — INSIDE one
paragraph's own text, which needs no split, no merge, and no `\n\n`-means-a-paragraph-break
convention to produce it: it is just two characters typed into a `white-space: pre-wrap` element,
where `\n\n` has always meant a blank line. The keymap (`listKeymap`, composer-editor.ts) becomes
`chainCommands(splitListItemUnchecked, outdent.run, insertSoftBreak)` — inside a list, nothing
changes; outside one, the chain now always returns `true` rather than falling through to
`baseKeymap`'s own split.

**`entrySchema`'s `paragraph` node needs `whitespace: "pre"` (entry-schema.ts), and this was not
predictable from the diff alone — it was found only by actually running the e2e suite, not reasoned
out ahead of time.** The command above is correct and its own unit tests (composer-commands.test.ts)
prove the model it builds is right. But a live browser test typing `alpha` (Enter) `bravo` showed
something no unit test could: right after Enter, the paragraph's own `innerHTML` was exactly
`"alpha\n<br class=\"ProseMirror-trailingBreak\">"` — correct — and then, the INSTANT the first
character of `bravo` was typed, it became `"alpha bravo"`: the `\n` silently replaced by a plain
space. This happened on the very first keystroke, with no race condition and no rapid-typing
involved (confirmed by polling for the trailing-break markup and pressing one single character at a
time). The command was never wrong; something downstream of it was erasing its own output the moment
anything else touched the same paragraph.

The cause is `prosemirror-model`'s own `DOMParser.addTextNode` (read directly, not assumed), which
`prosemirror-view`'s `parseBetween`/`readDOMChange` calls every time a native DOM mutation — ANY
keystroke, not just ones near the newline — has to be reconciled back into the document. It reads
`$from.parent.type.whitespace`, and passes `preserveWhitespace: "full"` only when that is exactly
`"pre"`; otherwise it passes plain `true`. Inside `addTextNode`, the `"full"` branch does
`value.replace(/\r\n?/g, "\n")` (normalise line endings, touch nothing else); the plain-`true`
branch — what an ordinary `paragraph` (`whitespace` defaulting to `"normal"`) actually gets — does
`value.replace(/\r?\n|\r/g, " ")`: every embedded newline character is REPLACED WITH A SPACE, on
purpose, because a "normal" textblock's real line breaks are modelled as separate nodes (a block
split, or a dedicated `hard_break`), never as a raw `\n` sitting inside one text run. A `\n` a
`Transaction` inserts directly into the model survives forever in memory and renders correctly the
instant it is inserted — nothing re-parses the DOM to produce THAT change — but the next time
ANYTHING in the same paragraph is typed, the browser mutates the DOM natively, ProseMirror reads that
mutation back through `DOMParser`, and the re-parse silently launders the `\n` back into a space, per
`entrySchema`'s own (until this ticket, default) claim that its paragraphs are ordinary "normal"
whitespace text.

Setting `whitespace: "pre"` on `paragraph` makes `type.whitespace == "pre"` true, which makes
`parseBetween` pass `"full"`, which makes `addTextNode` take the line-ending-only branch instead of
the newline-eats-space one. This affects PARSING alone, never rendering (the visual line break is
entirely index.css's `white-space: pre-wrap`/`break-spaces`, issue #158, unchanged) and never the
reader's own conversions (`entryMarkdownToDocument`'s `blocksToPM`/`inlineNodesToPM` build `PMNode`s
directly via `schema.text(...)`, with no `DOMParser` in that path at all) — only how a LIVE keystroke
or a paste reconciles a real contenteditable mutation back into the model. Without it, `insertSoftBreak`
would have been correct in isolation and broken the instant a person kept typing after using it —
the single most common thing to do right after pressing Enter — which would have made this ticket's
own acceptance bar ("alpha, Enter, bravo") fail in exactly the way its own test now catches.

**`collectBlocks` is untouched, on purpose, and that is the point of fixing it here rather than
there.** It was tempting to read the defect as "the reader shouldn't glue paragraphs back together
with a blank line" and try to teach it the difference between a deliberate gap and a forced one —
but there IS no difference to teach it. The stored text `"alpha\n\nbravo"` means exactly one thing
once it is on disk: a blank line between two lines of prose. Nothing in the string says whether a
person meant to leave a gap or was merely forced into one by the model's own inability to express
"two lines, no gap" as two block nodes. Fixing this in `collectBlocks` would mean changing what
EVERY existing separator means — reaching `entryBlocksToText` (which joins with a space and feeds
Digest's own snippets), checkbox toggle offsets, task promotion, reference detection, and the
691-case round-trip corpus, for an ambiguity that is created entirely on the WRITE side and
therefore only needs to be prevented there. `insertSoftBreak` is the lever that does that: it never
lets the ambiguous case get written in the first place, because it never produces two paragraph
siblings for typed text that has no gap in it. `a\n\n\n\nb` still round-trips as the identity;
nothing about that property moved.

**Shift-Enter binds to the IDENTICAL chain, not a variant of it, and it is bound explicitly rather
than left to fall through.** `prosemirror-keymap`'s own matching (read directly, not assumed) only
tries a bare key as a Shift fallback for single-character keys — "a" falling back from "Shift-A" —
never for a NAMED key like "Enter"; a keymap defining only `Enter` is never even consulted for
`Shift-Enter`. Left unbound, the keystroke reaches the browser's native contenteditable behaviour, a
bare `<br>` `entrySchema` has no node for at all, and ProseMirror's DOMObserver reconciles the DOM
straight back to the real document on its very next update — the keystroke vanishes with nothing to
explain why. That much was already true before this ticket (ADR 0044 recorded it) and does not
change.

What changes is which chain Shift-Enter should be identical TO. ADR 0044 bound it to
`chainCommands(splitListItem, liftListItem, splitBlock)` — the ordinary Enter chain, PLUS an
explicit `splitBlock` fallback rather than `baseKeymap`'s own, because plain Enter fell through to
`baseKeymap` on its own but Shift-Enter, unbound anywhere else, needed its OWN copy of that same
fallback to reach the identical behaviour. Under this ADR's model, that shape would be actively
wrong: `chainCommands(enterChain, splitBlock)` would make Shift-Enter split the block — literally
two soft breaks' worth of separation once serialized, since a block split still means `\n\n` — while
plain Enter, right next to it, inserts one `\n`. Shift+Enter would silently mean "insert a blank
line," a gesture with no name, no discoverability, and the exact opposite of UpNote's own
Shift+Enter (a single new line, identical to plain Enter — verified against its shipped bundle,
the same source ADR 0043/0044 already inspected for this app's editing model). The fix is not a
new fallback; it is binding `Shift-Enter` to the exact same `enterChain` plain Enter now uses, full
stop. `isSubmitChord` already excludes any Shift-held Enter before either keymap is reached, so
"Shift+Enter must never send" was never the question this decision turned on — both readings satisfy
it equally, and only one of them means what UpNote's own Shift+Enter means.

**The line-start input rules have to re-anchor, and this is not follow-up polish — it is the same
reader/writer seam ADR 0045 already named, reopened by this exact ticket.** `prosemirror-inputrules`
builds the text an `InputRule` matches against from `$from.parent.textBetween(...)` — the WHOLE
current textblock, not the visual line the caret happens to be on (verified by reading
`inputrules.ts`'s own `run()`, not assumed). Every line-start rule this Composer has —
`bulletListInputRule`, `orderedListInputRule`, `checklistShortcutInputRulePattern` — was written
`^`-anchored, which was equivalent to "the start of a line" for exactly as long as every line lived
in its own paragraph. The moment Enter stops splitting the block, that equivalence breaks: a second
line typed after a soft break lives in the SAME textblock as the first, so `^` can only ever match
the paragraph's own start — never again, no matter how many further lines follow. Left alone,
`alpha` (Enter) `- milk` would leave the literal characters `- milk` sitting on screen — the marker
never fires past the first line of any paragraph — while `parseEntryMarkdown` reads the STORED text,
`"alpha\n- milk"`, as a genuine two-block document: a paragraph followed by a bullet list. That is
exactly the failure ADR 0045's own account of the `*`/`1)` gap describes — the Composer showing a
reader something different from what `parseEntryMarkdown` will read the instant it is Sent — arising
at the very seam this ticket just finished closing for the OTHER half of the same defect.

`bulletListInputRule`, `orderedListInputRule`, and `checklistShortcutInputRulePattern` now match
`(?:^|\n)` rather than a bare `^`: a fresh block's own start, OR a position immediately following a
newline anywhere in the textblock's text. `checkboxInputRulePattern` stays `^`-anchored,
deliberately: its own handler only ever fires inside a `list_item`'s LEADING paragraph, and Enter
INSIDE a list item is still `splitListItemUnchecked` — a real block split, unchanged by this ticket
— so a `\n` can never appear inside that leading paragraph's own text for this rule to need to look
past. A soft break is a prose-only concept; it is unreachable from inside a list item at all.

The leading-whitespace run in `bulletListInputRule` changes from `\s*` to `[^\S\n]*` for a reason
specific to this widening, not a pre-existing gap: `\s` already matches a newline, so a naive
`(?:^|\n)\s*([-+*])\s$` would let its own leading run swallow a SECOND newline the reader
deliberately left — `alpha\n\n- milk` (a genuine blank line, then a bullet) would have that blank
line silently eaten into the marker's own leading whitespace, disappearing under this rule's `\n`
branch as readily as the ordinary indentation it was meant to tolerate. `[^\S\n]*` keeps matching
real indentation (spaces, tabs, NBSP) exactly as `\s*` always did, while refusing to consume any
newline beyond the one `(?:^|\n)` itself already accounted for.

**`bulletListInputRule`/`orderedListInputRule` share one new helper, `lineStartWrappingInputRule`,
rather than each hand-rolling the newline branch.** It behaves exactly like
`prosemirror-inputrules`' own `wrappingInputRule` when the match does not begin with `\n` — same
delete-then-wrap-then-maybe-join shape, `getAttrs`/`joinPredicate` included, unchanged. When the
match DOES begin with `\n`, it deletes the matched range (the `\n` and the marker together), then
`tr.split()`s the now-merged paragraph at that same point BEFORE wrapping anything — so the marker's
own line becomes its own, separate paragraph first, and only that new paragraph gets wrapped in a
list. `checklistShortcutInputRule`'s own hand-written handler (it was never built on
`wrappingInputRule` to begin with — `checked` lives on the `list_item` `findWrapping` inserts
underneath `bullet_list`, not on the `bullet_list` itself, which `wrappingInputRule`'s own `getAttrs`
has no hook for) gets the identical split-first prologue inlined, for the same reason.

Two position-arithmetic traps sit inside that split, both load-bearing and both worth naming
explicitly because neither is visible from reading the finished diff alone. First: `tr.split()`
inserts a close token and an open token at the split point — two positions' worth — so every
position downstream of it shifts by 2 the instant it runs; the wrap that follows has to resolve its
target through `tr.mapping.map(start, 1)`, never by reusing the pre-split `start` as a raw offset,
or it lands one node too early. Second: `blockRange()` has to be taken on that mapped, POST-split
position — the NEW trailing paragraph — never on the paragraph that precedes the split, or the
`findWrapping`/`tr.wrap()` that follows wraps the entire PRECEDING prose into the freshly-made list
item instead of just the marker's own line. The join predicate is dropped entirely on this branch —
a list started out of a soft-broken line has no adjacent list above it to join into; the paragraph
immediately before the split point is ordinary prose, not a `bullet_list`/`ordered_list` this new
one could ever merge with.

**Every line-start marker is now tested in TWO positions, not one — `composer-editor.test.ts`'s
`lineStartPositions()`.** ADR 0045's own symmetry loop (`READER_BULLET_MARKERS`/
`READER_ORDERED_DELIMITERS`, driving both `parseEntryMarkdown` and `buildInputRules()` off one
shared alphabet) checked recognition only at a fresh block's start. That loop now runs each marker
at block start AND after a soft break inside an existing paragraph — a fixture built directly
against `entrySchema` as one paragraph whose own text is `"alpha\n"`, matching exactly what
`insertSoftBreak` leaves behind, rather than two paragraph nodes a parse would have produced. A
marker recognised at block start but not after a soft break is precisely the reader/writer split
this ADR's own Context section describes; this is the test that fails it by construction, the same
property ADR 0045 built its own original loop for.

## Consequences

**A body typed with soft breaks is now what `entryDocumentToMarkdown` and `parseEntryMarkdown`
always agreed a plain, gap-free two-line Entry should look like, without either of them changing.**
`insertSoftBreak` produces one paragraph with an internal `\n`; `writeBlocks`' own existing branch —
"a paragraph sibling needs a blank line... written only when the paragraph does not already begin
with a newline" — already treats a paragraph beginning with `\n` as carrying its own separator, so a
document built this way was ALREADY the shape that branch expects. Nothing in entry-document.ts
changed for this ticket; the fix is entirely upstream of it, in what kind of document the Composer
now hands it in the first place.

**Leaving a list still produces a blank line where prose Enter does not, and that asymmetry is
pre-existing, not something this ticket introduced.** Enter on an EMPTY top-level list item still
falls through `splitListItemUnchecked` (returns `false`, "bail out and let the next command handle
lifting") to `outdent.run` — `liftListItem`, which lifts the item's content out as a genuinely NEW,
separate paragraph sibling of the list, with bare text and no leading `\n` of its own. `writeBlocks`
sees exactly that shape — a fresh paragraph sibling, `needsSeparator` true, no leading `\n` — and
inserts `\n\n` ahead of it, the same as it always has for any two genuinely separate paragraph
siblings. Leaving a list by Enter therefore still leaves a blank line behind; continuing a line of
plain prose by Enter no longer does, because the two no longer produce the same kind of document
node. This was always true of `liftListItem`'s own behaviour — it is named here, not newly
introduced, because it is now the one remaining place in this Composer where Enter still splits the
block outside of continuing a list item, and a future reader deserves to find that written down
rather than rediscover it by typing.

**A newline dispatched by `insertSoftBreak` can never itself re-trigger an `InputRule`.** It is a
plain document edit (`state.tr.replaceSelectionWith(...)`), never routed through
`handleTextInput` — the one function `prosemirror-inputrules`' own plugin actually listens on. This
matters concretely for the re-anchored rules above: they match a `\n` that is already sitting in the
textblock's text by the time a LATER character is typed, but the `\n` itself, at the moment it is
inserted, is not itself a character any rule's own trailing-space/trailing-marker pattern is looking
for — so dispatching it this way cannot loop a soft break back into firing a rule of its own.

**`code` is the one mark a soft break deliberately does not inherit.** Every other active mark
(`strong`, `em`, `strikethrough`) continuing across a soft break is the wanted behaviour — typing
stays bold on the next line, the same as it would mid-word. `code` is refused because a code span's
own backtick-fence length (`entry-document.ts`'s `writeCodeSpan`) is chosen long enough to beat
every backtick run ALREADY inside the span; a newline living inside one is invisible to that choice
today, and a later edit that has to widen the fence to dodge a sequence spanning the newline's own
neighbours would be a silent content edit for a keystroke that looks, on screen, like nothing more
than moving to the next line.
