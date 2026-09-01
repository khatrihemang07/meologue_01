# 0045: Recognition may exceed emission

## Status

Accepted. **Extends [0043](0043-an-entry-may-carry-structure.md)**, whose "two parse entry points
over **one dialect**" claim this ADR narrows — and, for `*`, corrects: the claim was false the day
it shipped, not merely incomplete. **Extends [0044](0044-the-composer-holds-a-document.md)**, whose
input rules were built to the letter of that claim and inherited its gap. Depends on issue #158,
whose nbsp-tolerant checkbox pattern this ADR's own new checklist trigger reuses the reasoning of.

## Context

ADR 0043 wrote, of the reader's `parseEntryMarkdown` and the Composer's input rules, "there are
therefore two parse entry points over **one dialect**." That sentence was checked against the mark
set — bold, italic, code, `[[…]]` References — where it holds exactly. It was never checked against
the block grammar 0043 itself introduced in the same breath, and there it does not hold.

CommonMark's own bullet-list grammar recognises three marker characters, not two: `-`, `+`, and
`*`, all equally valid, none preferred. `entryParser` (inline-markdown.ts) configures `@lezer/
markdown`'s stock `commonmark` parser with no override to that alphabet, so `parseEntryMarkdown`
has always accepted `* milk` as a bullet exactly as readily as `- milk`. `bulletListInputRule`
(composer-editor.ts), meanwhile, was written as `/^\s*([-+])\s$/` — two characters, not three — from
the day issue #155 introduced it. Ordered lists carry the same shape of gap: CommonMark's delimiter
after the digits is `.` **or** `)`, `orderedListStart`'s own comment already said so ("`1.` and
`1)` both give 1") before this ticket touched it, and `orderedListInputRule` matched only `.`.

The result was not a cosmetic inconsistency. `entry-document.ts`'s `escapeUserText` backslash-escapes
a leading `*` on Send, on the ordinary and correct theory that stray punctuation at the start of a
line must not be misread as a marker on the next parse. That escape was quietly load-bearing for a
gap in a DIFFERENT file: it existed to protect prose that happened to start with `*`, and it was
also the only thing standing between a typed `* milk` and a broken round trip, because
`bulletListInputRule` was never going to consume that `*` on the way in. Typing `* milk` into the
Composer left the literal characters `* milk` on screen for as long as it was being edited — the
Composer showing the reader something it would not, in fact, get — and the moment it was Sent,
`parseEntryMarkdown` read the very same characters as a bullet. Two parse entry points disagreeing
about the SAME typed text, at the exact seam ADR 0043 said they could not.

This was found by typing on a real macOS build — `* milk`, then `1) alpha` — not by re-reading the
regexes and noticing the alphabet was short. It is the kind of gap a diff review of
`bulletListInputRule` alone would not surface either: the regex reads as internally consistent, and
nothing about `/^\s*([-+])\s$/` looks unfinished sitting on its own. It only looks unfinished next to
`entryParser`'s own configuration, which is a different file, changed on a different ticket, eleven
issues earlier.

Separately, and for an unrelated reason — feel, not correctness — a checklist has always cost two
keystroll steps in this Composer: type `- ` to open a bullet, then `[ ] ` at that item's own start to
upgrade it into a task. UpNote — the same shipped application ADR 0043 and 0044 both inspected
directly for its editor architecture — collapses that to one: `[]` and a space at the start of a
line makes a checklist item directly, no bullet in between. Nothing about this is a symmetry gap the
way `*`/`1)` were; GFM's own `TaskList` extension only ever fires inside an existing `ListItem`
(inline-markdown.ts's own comment on `entryParser` says so explicitly), so a bare `[] ` outside a
list has never meant anything to the reader and still does not. It earns a place in this same ADR
anyway, because closing it needed the same kind of decision the `*`/`1)` fix did: teach the Composer
to recognise something on the way in that the stored form never needs to spell on the way out.

## Decision

**`bulletListInputRule` now matches `[-+*]`, and `orderedListInputRule` now matches `[.)]` after the
digits — the Composer's list markers now cover exactly the alphabet `parseEntryMarkdown` already
accepted, closing the gap rather than narrowing the reader to match the writer.** `*` was chosen as
the direction to fix in, not "teach `entryParser` to reject `*`," because rejecting it would trade a
Composer-side defect for a worse one: pasted or hand-typed GFM using `*` bullets — an ordinary,
common spelling, arguably the MORE common one in Markdown written outside this app — would silently
stop rendering as a list at all. A person who has never opened this Composer and only ever pastes
Markdown into it would see their list flatten into a paragraph, with no error and no way to know why.
Widening recognition costs nothing GFM does not already accept; narrowing the reader would take
something away from every source of a body that is not this Composer's own keystrokes.

**A new input rule, matched by `checklistShortcutInputRulePattern` (`/^\[([xX]?)\]\s$/`), makes
`[] `, `[x] `, and `[X] ` at the start of a plain paragraph into a checklist item in one step —
`bullet_list` wrapping a `list_item` with `checked` set, built by hand rather than through
`wrappingInputRule`, because `checked` lives on the `list_item` `findWrapping` inserts underneath
`bullet_list` to satisfy its own `"list_item+"` content expression, and `wrappingInputRule`'s
`getAttrs` only ever reaches the outermost node it wraps in, never that inner one.** The existing
two-step path — `- ` then `[ ] ` — is untouched: `checkboxInputRule` still owns upgrading an
ALREADY-listed item, guarded by requiring an enclosing `list_item`; the new rule is guarded by the
opposite requirement, a paragraph that is NOT already a list item's child, so the two can never both
fire on the same keystroke and neither can shadow the other. A `[] ` typed anywhere but the very
start of a block — mid-sentence, or inside an existing list item's own paragraph — matches neither
rule's regexp (both are anchored with `^` against the current textblock's own text, which is exactly
where prosemirror-inputrules itself draws that same line) and so stays exactly as typed, a checkbox
outside a list still meaning nothing in this dialect, unchanged from ADR 0043.

**Emission is unchanged, and that is now a deliberate, named asymmetry rather than an implied one.**
`markerFor` (entry-document.ts) still writes only `- ` for a bullet and `N. ` for an ordered item,
regardless of whether `*`, `+`, `-`, `1.`, or `1)` created it; the serializer still writes only GFM
`- [ ] `/`- [x] ` for a task, regardless of whether it was built through the two-step upgrade or the
new one-step shortcut. None of this ADR touches `entry-document.ts` at all. **What you type is
understood; what is stored is canonical** — recognition now covers strictly more spellings than
emission ever produces, on purpose, and that gap is not a defect the way the `*` gap was: it is the
same normalizing property ADR 0044's own "Dirty-only commits" section already established for the
Composer's document model in general (`entryDocumentToMarkdown` "always produces the SAME canonical
text for equivalent documents"), now stated for marker spelling specifically rather than left to be
inferred from a sentence about something else.

**The regression test this gap deserved is a symmetry test, not a list of cases.** A test enumerating
`"* "`, `"1) "`, and `"[] "` as three assertions would have looked exactly as complete as the test
suite already had before this ticket, and would have caught nothing the next time a new marker
spelling landed on one side of the dialect and not the other. `composer-editor.test.ts` instead
declares `READER_BULLET_MARKERS` and `READER_ORDERED_DELIMITERS` once — CommonMark's own alphabets,
the ones `entryParser` is configured against — and drives BOTH `parseEntryMarkdown` and
`buildInputRules()` off that single shared list, calling a rule's own exported `match`/`handler`
directly (jsdom cannot mount a ProseMirror `EditorView` at all, ADR 0044) rather than typing through
a mounted view. Add a marker to `entryParser`'s configuration without teaching an input rule to
recognise it, or the reverse, and this loop fails by construction — the same property a hand-checked
list of cases cannot offer, because a hand-checked list only ever tests what someone remembered to
write down, which is exactly what went missing for `*` in the first place.

## Alternatives considered

- **Narrow `entryParser` to reject `*` and `)` instead of widening the Composer's input rules.**
  Rejected above, at length: it repairs the symmetry ADR 0043 promised at the cost of breaking
  ordinary, already-valid GFM the moment it arrives from anywhere but this Composer's own keystrokes
  — pasted text, an imported note, a body written by a future second client. The Composer catching up
  to the reader it already claimed to match is the fix; the reader forgetting what it already knew is
  not.
- **Leave `escapeUserText` doing the work and declare the gap closed once a stray `\*` no longer
  displays wrong.** This was, in effect, the state of the code before this ticket, and it is not a
  fix: it protects the ESCAPED, at-rest text from being misread on a later parse, but it does nothing
  for the Composer's own live document while `* milk` is still being typed — the two parse entry
  points still disagreed about what a person was looking at on screen, for as long as the cursor was
  still in that line. Closing that gap needed the input rule widened, not the escape left standing on
  its own.
- **Make `markerFor` remember and round-trip the typed delimiter — `*` stays `*`, `1)` stays `1)`
  through a Send/reopen cycle — instead of canonicalizing every bullet to `-` and every ordinal to
  `N. `.** Rejected on ADR 0044's own already-accepted normalizing-serializer property: `entrySchema`
  has nowhere to remember which marker character created a `bullet_list` or a `list_item` — carrying
  it would mean a new attribute on both node types, threaded through `entryMarkdownToDocument`,
  `blocksToPM`, and every property test built against the CURRENT two-shape output, for a distinction
  that is invisible the instant the item renders. A `- milk` and a `* milk` look and behave
  identically once they are bullets; there is no reader-facing reason to remember which one a person
  happened to type.
- **A single, one-step trigger for the checklist's UNCHECKED spelling that also accepted a literal
  space — `[ ] ` as well as `[] ` — matching the checked spellings' own two-character width.**
  Rejected: `[ ] ` (a literal space between the brackets) is the exact GFM spelling
  `checkboxInputRulePattern` already owns as an UPGRADE trigger, and the two rules' guards are each
  other's negation specifically because neither pattern overlaps the other's matched text. Widening
  the new rule to also match `[ ] ` would have made the two patterns match the SAME literal text for
  the unchecked case, leaving which one actually fires dependent on array order in
  `buildInputRules()` rather than on the guard logic either rule is actually written around — a
  fragile way to keep two rules from fighting over one keystroke, for a spelling UpNote's own trigger
  (verified in its shipped bundle) never uses in the first place.
- **Join a freshly one-step-created `bullet_list` into an immediately adjacent one**, the way
  `wrappingInputRule`'s own built-in join already does for `bulletListInputRule`/
  `orderedListInputRule` above it. Deferred: the join exists to keep a list one continues typing into
  from fragmenting, and continuing INTO an existing list already goes through `splitListItem`
  (`listKeymap`) on Enter, which keeps the whole item lineage in one `bullet_list` long before the
  one-step rule would ever run a second time. The case the join would additionally cover — this exact
  rule firing twice back-to-back against two freshly-typed TOP-LEVEL paragraphs, with no
  Enter-inside-a-list-item ever occurring between them — is not how a checklist actually gets built
  one item at a time, and was not part of issue #161's acceptance bar.
- **A hand-maintained list of the three specific fixed strings (`"* "`, `"1) "`, `"[] "`) as the
  regression test**, rather than a marker-driven loop. Rejected as the whole point of this ticket:
  that is exactly the shape of test that already existed around every OTHER construct in this file
  and did not catch the `*` gap, because a hand-written list only tests what someone remembered to
  write down.

## Consequences

**ADR 0043's "one dialect" claim is now precise rather than aspirational, and precise in a way that
is asymmetric on purpose.** Recognition — what `parseEntryMarkdown` accepts and what
`buildInputRules()` triggers on — is now genuinely one alphabet, checked by a test that fails the
moment the two drift again. Emission — what `markerFor` and the serializer actually write — is a
strict SUBSET of that alphabet, and always has been for `1. ` vs `1)` specifically (the join
predicate already only ever compared against `markerFor`'s own numbering, never against which
delimiter was typed); this ADR is what makes that subset relationship explicit for bullets too,
rather than leaving it implied by one comment on one join predicate.

**A body sent from the Composer can no longer contain a literal `*` bullet, a literal `1)` ordinal,
or a literal `[] ` checklist marker at rest — those spellings exist only transiently, while a line is
still being typed, never in what `entryDocumentToMarkdown` actually writes.** Opening an Entry that
was typed with `* milk` for editing shows a `bullet_list` item indistinguishable from one typed with
`- milk`; there is no way, short of comparing stored bytes from before the first edit, to tell which
spelling created it. This was already true of `1.` vs `1)` before this ticket and is now true of `-`
vs `+` vs `*` as well — a consequence of ADR 0044's normalizing serializer, stated here for the
marker alphabet specifically.

**The symmetry test is now the enforcement mechanism for ADR 0043's claim, not the claim's prose.**
A future change to `entryParser`'s configuration — a new marker, a widened delimiter set, a GFM
extension enabled — that does not also teach an input rule the same spelling fails
`composer-editor.test.ts` immediately, by construction, rather than shipping a second `*`-shaped gap
that only turns up on a real device months later.

**The one-step checklist trigger adds Composer-only surface area with no reader-side counterpart at
all**, unlike `*` and `1)`: `parseEntryMarkdown` has never recognised a bare `[] ` outside a list
item and still does not — `checklistShortcutInputRulePattern` is not closing a reader/writer gap the
way the marker-alphabet fixes are, it is a faster path to structure the reader already understood
through `- [ ] `. It adds no new stored spelling, no new parser obligation, and nothing for the
symmetry test to enforce, because there is no reader-side marker on the other end of it to be
symmetric with.
