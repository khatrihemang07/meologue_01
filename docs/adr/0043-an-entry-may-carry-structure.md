# 0043: An Entry may carry structure

## Status

Accepted. **Supersedes [0041](0041-prose-renders-as-inline-markdown-at-render-time.md)**, whose
inline-only decision this reverses for Entries and keeps for everything else. Depends on
[0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md), whose floated clock had to
move before a block could exist at all, and on
[0042](0042-a-reference-is-a-mark-in-the-body.md), whose `[[…]]` marks now have to survive inside a
list item. [0044](0044-the-composer-holds-a-document.md) turns the writing surface into a document
editor on top of what this ADR renders.

## Context

ADR 0041 refused block structure eighteen days ago, and it refused it well. Two shipped decisions
depended on a body being exactly one line box — the Entry bubble's right-floated clock and
`useFittedDigests`'s `scrollHeight / lineHeight` arithmetic — and neither would have failed loudly.
`parseInline` was chosen because it has *no block layer to suppress*, so no later edit to a
deny-list could reintroduce one.

That reasoning has not become wrong. What changed is the premise underneath it.

0041 rested its refusal on two legs. The first was layout, and it was real. The second was the
domain: `CONTEXT.md` refused the word "note" because "a note implies something that can be retitled
or organized into a document. An Entry stays untitled and unorganized," and 0041 observed that "the
layout constraint and the domain constraint happen to point the same way, and that agreement is
what makes inline-only a decision rather than a workaround."

The agreement has come apart, because the second leg turned out to be two claims wearing one
sentence. **Untitled** and **unorganized** are not the same property. An Entry that contains a
checklist is still untitled: nobody named it, nothing files it, it is still found by when it was
captured and what it says. Refusing lists never protected untitledness. It only made people write
worse Entries — a shopping list captured as a comma-separated run-on, a set of things to do
flattened into a paragraph — because the alternative was punctuation on screen.

So this ADR keeps the half of the sentence that was doing work and drops the half that was not.

**On the WYSIWYG framing.** The request named Obsidian and UpNote together. They are opposite
architectures, and the difference decides what is possible here. Obsidian stores Markdown files and
hides syntax only while the caret is off the line. UpNote — verified by inspecting the shipped
application, not its documentation — stores **HTML in SQLite**: its `notes` table has an `html`
column, 278 of 326 rows begin with `<`, and its editor is bespoke `contenteditable` with no
ProseMirror, Lexical, CodeMirror or Slate anywhere in the bundle. Typora is the same story. All
three built their editor in-house.

That matters here because it means "never show syntax" and "Markdown is what is stored" are not
one goal. UpNote gets the first by giving up the second. This ADR keeps Markdown as the stored form
and pays for it elsewhere — see 0044, which is where the cost actually lands.

## Decision

**Block structure is a property of an Entry's body, not of prose in general.** ADR 0041 is
superseded only where an Entry's own text is concerned. The Digest reader, the clamped Digest card,
the Question and both Answer surfaces keep rendering through the inline-only path, unchanged. Issue
#148 installed that seam ahead of this change as a pure prefactor, so this ADR had a place to put
the divergence rather than having to create one while also changing behaviour.

There are therefore two parse entry points over **one dialect**. The inline marks and the `[[…]]`
`referenceParser` are defined once, so a Reference cannot come to mean one thing when read and
another when written. Only the block layer differs.

**The mark set gains lists and checkboxes, and deliberately not headings.** Bullet lists, ordered
lists, task-list checkboxes and nesting are in. ATX and setext headings, blockquotes, fenced code,
indented code blocks and thematic breaks are **removed from the dialect** rather than filtered after
parsing — the same structural argument 0041 made for `parseInline`, applied one level down. A
deny-list over a pipeline that still parses a construct can be edited back open by accident; a
parser that was never installed cannot.

Headings are excluded for the reason the glossary now gives: an Entry is still untitled. A heading
inside a body is the first step toward a document with a name, and nothing in the request asked for
one. This is the line, and it is drawn on purpose rather than by omission.

**Raw HTML remains impossible rather than disabled.** `HTMLTag`, `HTMLBlock` and `Entity` stay
removed, the walker emits React nodes, and there is no HTML string anywhere in the path. No
sanitizer was added, for the same reason 0041 did not add one.

**The clock had to move first, in its own change.** ADR 0036 records that the bubble's body is
unwrapped inline content precisely so a right-floated `BubbleMeta` has a line box to land on, and
that the first attempt in that area "passed every test and was wrong on screen; only a screenshot
caught it." A list has no line box to share. Issue #149 moved the clock onto its own row as a
separate, separately-reviewable change, while bodies were still inline-only — so that if the
bubble's layout regressed, the regression had exactly one candidate cause.

**A checkbox is clickable, and ticking it splices the stored string.** The parser reports the source
offset of each task marker, and a tick rewrites those characters and nothing else. It does not
round-trip through the Composer's document model. This is the difference between reading History and
quietly reformatting it: with a splice, the Composer stays the only thing in the app that can
normalize a body.

A tick is an ordinary Entry edit and inherits everything that follows — it Syncs, and it marks the
Period's Digest stale (ADR 0039). That is correct and it is also new: reading your History can now
change it.

**The Server is still not invited to write structure.** The Digest prompt is unchanged and still
asks for plain prose, and the Digest surfaces still render inline-only, so a stray marker degrades
into formatting rather than punctuation exactly as 0041 arranged. Entries reach the model with their
markers intact, because nothing rewrites a body on the way there.

## Alternatives considered

- **Keep inline-only and reject the request.** The honest option, and it survives if you believe
  "unorganized" was load-bearing. It is not: refusing lists changed how people wrote Entries, not
  whether they filed them.
- **Blocks everywhere, one renderer.** Simpler and consistent. Rejected because `useFittedDigests`
  divides `scrollHeight` by `lineHeight`, and ADR 0041 already established that the Digest is the
  *worst* surface to admit a block into, not the safest. The failure is silent — wrong card heights,
  no error.
- **Headings too, since the glossary is being rewritten anyway.** Rejected. Nothing asked for them,
  and they are the construct that actually turns an Entry into a document with a name. Adding them
  later is cheap; removing them once bodies contain them is not.
- **Filter block nodes after parsing instead of removing the parsers.** Rejected on 0041's own
  reasoning: a deny-list is one careless edit away from being wrong, and the thing it protects is
  invisible to tests.
- **A separate field for structured Entries, leaving `body` plain.** A second representation to keep
  in step, a migration, and a `PROTOCOL_VERSION` bump that 426s every Device that has not updated —
  for something Markdown already expresses as characters.
- **Round-trip a checkbox tick through the Composer's document.** One write path instead of two.
  Rejected: every tick would re-serialize the whole body, so merely reading History would normalize
  Entries the user never edited.

## Consequences

**1. `CONTEXT.md`'s refusal of "note" is gone.** It was the load-bearing statement of a property
this ADR abandons in part, and leaving it in place while shipping lists would have made the glossary
lie. "Message" stays refused, on grounds this change does not touch: an Entry still has no
addressee.

**2. The guarantee that used to be asserted for every surface is now asserted for some.** The test
that proved no input produces a block element still exists and still runs — pointed at the
Digest/Question/Answer path, which is what protects the clamp. For an Entry it is replaced by its
inverse: list syntax must produce a list, and heading, blockquote, fence and rule syntax must not
produce anything but the characters typed.

**3. An Entry's body can now be ambiguous to a reader that assumes one line per Entry.** The Server
renders Entries to the model as `[YYYY-MM-DD] body`, one per line. Issue #151 indents continuation
lines so the date prefix still marks each boundary — a bug that already existed, since a plain Enter
has always produced a multi-line body, and one this change would have made considerably worse.

**4. Token estimates drift slightly.** `chunk_entries` estimates a Digest's input as `len() / 4`.
List markers inflate that count, so chunk boundaries shift a little. Harmless, and named here so it
is not mistaken for a defect later.

**5. Export gains a collision it did not have.** A day file is written with the day as a heading.
Headings are not in the mark set, so a body cannot open with one — but list markers now appear in
day files as structure rather than as incidental punctuation, which makes reading an export back by
hand slightly more ambiguous than ADR 0016 assumed.
