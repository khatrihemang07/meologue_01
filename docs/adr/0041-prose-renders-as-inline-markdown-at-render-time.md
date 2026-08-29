# 0041: Prose renders as inline Markdown at render time

## Status

Accepted. Extends [0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md), whose
floated clock and proportional Digest clamp are the two constraints that decide the shape of this
one. It supersedes nothing. [0042](0042-a-reference-is-a-mark-in-the-body.md) builds the `[[…]]`
mark family on the parser this ADR installs.

## Context

An Entry's body was rendered as a bare string. Someone who wrote `**deadline**` saw the asterisks,
which is not what anyone means by writing them.

The obvious change — parse the body as Markdown — is not obvious at all here, because two shipped
decisions depend on a body being **exactly one line box**, and neither states that in a way a
Markdown renderer would notice.

**The Entry bubble's clock is a right float.** ADR 0036 records that the bubble's body is a
`<span>` rather than a `<p>` precisely so `BubbleMeta`'s right-floated clock has a line box to land
on; with a block wrapper the float drops beneath the whole block and a one-word Entry costs two
lines. That ADR also records that the first attempt at this "passed every test and was wrong on
screen; only a screenshot caught it."

**The Digest card counts lines by division.** `useFittedDigests` reads the prose element's
`scrollHeight` and divides by its `lineHeight` to get a line demand, which
`allocateLineBudgets` then distributes across three cards. That arithmetic is only meaningful if
the element is one block box containing uniform lines. A heading, a list, or a `<p>` inside it does
not fail loudly — it silently returns a wrong number, and the cards clamp to the wrong heights.

So the question was never "which Markdown library". It was "how do we make a block element
impossible", given that the thing which breaks is invisible to tests.

There was a second, quieter constraint. `CONTEXT.md` refuses the word "note" for an Entry because
"a note implies something that can be retitled or organized into a document. An Entry stays
untitled and unorganized." Headings and bullet lists are exactly the machinery of a document. The
layout constraint and the domain constraint happen to point the same way, and that agreement is
what makes inline-only a decision rather than a workaround.

## Decision

**Markdown is a render-time interpretation of a body that is still one plain string.** `Entry.body`
does not change type, gains no sibling field, and needs no migration; `PROTOCOL_VERSION` stays at
4, so no Device is locked out by a 426. Export writes the same characters it always did. What the
user typed is what is stored, and formatting is something the reader does to it — which also means
turning this off would cost nothing but a render path.

**The parser is `@lezer/markdown`, used through `parseInline`, and inline-only is structural rather
than configured.** `parseInline` never enters the block layer at all: `# heading`, `- item`,
`> quote` and a fenced block produce no nodes and reach the reader as the characters that were
typed. This is the property that was actually being shopped for. Every alternative below can be
*configured* to suppress blocks; this one has no block layer to suppress, so no future edit to a
deny-list can reintroduce one.

**Raw HTML cannot be produced, rather than being disabled.** The dialect removes the `HTMLTag` and
`Entity` inline parsers, and the walker emits React nodes — there is no HTML string anywhere in the
path and no `dangerouslySetInnerHTML` to reach for. That is what makes a sanitizer unnecessary
rather than merely omitted, and it is why no sanitizer dependency was added.

**The mark set is bold, italic, inline code, and `[[…]]` — and deliberately nothing else.**
`Link` and `Image` are removed: `[label](url)` is not in the set, and Link would otherwise consume
`[[` before our own parser saw the second bracket, so one removal serves both purposes. A bare URL
is not autolinked, which needs no removal because `Autolink` is not in the default dialect.
Backslash escapes are kept, so a user who means a literal asterisk has a way to say so. Nesting is
kept, which is the single reason a real parser was worth a dependency at all: the emphasis
delimiter-run algorithm is the part of inline CommonMark that hand-rolled tokenizers get wrong.

**All seven prose surfaces render through the same path.** The Entry bubble and Grounding share
`entryBodyContent`, which was already the single choke point. The Digest reader, the clamped Digest
card preview, the Question, and both Answer surfaces call the same renderer. The two Answer
surfaces — the streaming one and the settled one — were first collapsed onto one component, because
they render the same prose in different elements and formatting only one would have made the text
visibly reflow the instant streaming ended.

**Search highlighting moved from raw character offsets to the text of each parsed node.** It
previously sliced the body by offsets returned from a tokenizer mirroring FTS5's `unicode61`. It
now runs inside each text node instead. A phrase that spans a formatting mark therefore no longer
highlights — an acceptable and quiet loss, since FTS5 never indexed the marks either.

**No server prompt was softened.** The Digest prompt still instructs the model to write plain prose
with no Markdown, and Reflection's prompt is untouched. The Server is not invited to emit marks;
these surfaces render them only so that nothing is displayed as raw punctuation if one ever
appears. One sentence in the Digest prompt did change: it claimed "the Digest is rendered as plain
text," which this ADR makes false. It was replaced with a true statement of the same purpose. The
prompt still begins with the exact phrase "You are the Digest writer", which two test stubs outside
that crate sniff for, and `ValidatedDigestBody` is untouched.

## Alternatives considered

- **A hand-rolled tokenizer.** Zero dependencies, emits React nodes, cannot produce HTML by
  construction — and it was the recommendation until nesting was chosen. Nesting turns a flat
  segment list into a tree and hands you the emphasis delimiter-run algorithm, which is precisely
  the part that regexes handle badly. An early draft of the walker in this very change lost the
  text inside `**bold**` outright and passed the entire existing suite while doing it, which is a
  fair sample of the risk.
- **`react-markdown`.** Emits React nodes and drops raw HTML structurally, so it fails neither of
  the safety constraints. It fails the load-bearing one: it has no inline-only mode, so blocks are
  suppressed by a deny-list over a pipeline that still parses them. It also adds 81 transitive
  dependencies to a web app that had none of this kind.
- **`markdown-it`.** Best-maintained of the candidates, and `parseInline` hands back a token array
  that can be walked to React nodes without `dangerouslySetInnerHTML`. Heaviest survivor at ~46 kB
  gzipped with six transitive dependencies, and inline-only is a mode you select rather than a
  layer that does not exist.
- **`marked`, `snarkdown`.** Both emit HTML strings, so both require `dangerouslySetInnerHTML` and
  therefore a sanitizer. `snarkdown` concatenates unmatched source through unescaped, with no way
  to turn it off.
- **`commonmark`, `markdown-to-jsx`, `marked-react`.** All three were ruled out on custom syntax:
  the first two have no mechanism for adding inline syntax at all, and the third drops unknown
  tokens with a `console.warn`, which would have made `[[…]]` unimplementable.
- **Block-level Markdown on the Server's prose only, inline on Entries.** Attractive because a
  Digest is a paragraph of writing rather than a captured thought. Rejected because the Digest card
  clamp divides `scrollHeight` by `lineHeight`, so the Digest is the *worst* surface to allow a
  block into, not the safest.

## Consequences

**1. The guarantee needs a test that names it, because the thing it protects is invisible to
tests.** "The renderer emits no block element for any input" is asserted directly rather than
inferred from surface tests, since every surface test would pass with a `<p>` in the tree. The
floated clock and the clamp are checked on screen, not only in jsdom — ADR 0036's own record of a
defect that passed every test is the reason.

**2. A body now has a syntax, and syntax has false positives.** An Entry about multiplication, a
shell glob, or a snippet with underscores can format itself unintentionally. Backslash escapes are
the escape hatch, and they are in the mark set for exactly this reason rather than for
completeness.

**3. The Digest prompt and the Digest reader now disagree on purpose.** The model is told not to
emit Markdown; the reader would render it if it did. This is deliberate — it means a stray asterisk
degrades into formatting rather than into visible punctuation — but it is a gap that nothing
mechanical enforces, exactly as ADR 0040 already noted for the validator.

**4. Highlighting and searching can now disagree at a mark boundary.** A search matches the body as
stored, and highlighting runs over the text as rendered. A query whose phrase straddles a
formatting mark will match the Entry and highlight nothing inside it.
