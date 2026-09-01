# 0044: The Composer holds a document

## Status

Accepted. Builds on [0043](0043-an-entry-may-carry-structure.md), which gave an Entry's body a
block grammar — lists, checkboxes, References nested inside them — but left the Composer itself a
`<textarea>` holding a plain string, formatted only after Send. This ADR is the other half of that
ticket: the Composer becomes a ProseMirror `EditorView` holding a live document in the same grammar,
so formatting appears as it is typed. Depends on issue #154's `entry-schema.ts`/`entry-document.ts`,
which this ADR consumes rather than rebuilds.

## Context

Writing `**deadline**` in the Composer showed the asterisks. It became bold only once the Entry was
Sent and re-rendered through `inline-prose.tsx`. That gap — what you are writing does not look like
what you will have written — is what issue #155 asked to close, for the same three constructs 0043
already taught the reader's own render path: bold/italic/code marks, lists, and task checkboxes.

Closing it needs an editor with a document model, not a string with a bigger regex. A `<textarea>`
has one thing to say about its content: a range of plain text. There is nowhere in that model to
attach "this run is bold" without inventing a second, parallel representation and keeping the two in
step by hand on every keystroke — which is exactly the class of bug ADR 0036 already named once
("passed every test and was wrong on screen").

## Decision

**ProseMirror, chosen over Lexical, Tiptap, CodeMirror 6 and BlockNote — on tree-shaken gzip weight,
verified by building each and measuring the entry chunk with `check-bundle-size.mjs`.**

| Library | Verified gzip |
|---|---|
| ProseMirror (the 9 packages this ticket adds) | **68.6 KB** |
| Lexical (markdown-capable set, + `@lexical/react`) | 123 KB |
| Tiptap 3 (core + markdown round-trip) | 143 KB + 50 KB |
| CodeMirror 6 (upper bound) | 207 KB |
| BlockNote | 419 KB |

Weight was decisive but not the only reason — see "the one-grammar property" below for the one that
would have ruled Lexical out even at ProseMirror's own size. CodeMirror 6 and BlockNote were the
easiest refusals: CodeMirror is a code/text editor with no native rich-document model at all (an
Entry's lists and marks would be bolted on as a second layer), and BlockNote is a finished
block-editor product built ON ProseMirror, at more than six times its underlying engine's weight,
for defaults (drag handles, a slash-command menu, full block-type switching) this Entry — deliberately
not a document, ADR 0043's own "untitled and unorganized" — has no use for.

With the App.tsx lazy boundary issue #150 built (`ComposerPage` is `React.lazy`), none of this
weight reaches a cold start at all: the entry chunk measured **60,228 bytes gzip** after this
ticket landed, against a 60,223-byte baseline and a 78,000-byte ceiling — ProseMirror lands entirely
inside `composer-page`'s own chunk (**100.90 KB gzip**, 328.27 KB raw), which only loads once a
reader opens `/composer`.

**`prosemirror-markdown` is refused as a dependency.** It is mostly the *parser* half — a
`markdown-it`-backed reader that turns Markdown into a ProseMirror document — and this repo already
has that reader, for one dialect: `parseEntryMarkdown` (`inline-markdown.ts`, issue #152), built on
`@lezer/markdown` with headings/blockquotes/fences/HTML structurally removed (ADR 0043's own
reasoning: a parser that was never installed cannot be reintroduced by a careless later edit).
Adding `prosemirror-markdown` on top would mean two parsers recognising the same `[[…]]` Reference
syntax, free to drift apart — the drift `inline-markdown.ts`'s own module comment names as the
reason a Reference is defined once. `markdown-it` alone measures ~47.9 KB gzip of `prosemirror-markdown`'s
~61.2 KB total; refusing it is not a rounding error on top of the 68.6 KB above. `entry-document.ts`
(issue #154) already supplies both conversions this ticket needs — `entryMarkdownToDocument` and
`entryDocumentToMarkdown` — proven stable by a 691-case property test; this ticket calls them and
writes no third.

**The one-grammar property is why ProseMirror beat Lexical specifically, independent of size.**
`entryMarkdownToDocument` is built directly on `parseEntryMarkdown` — the SAME parser
`entry-prose.tsx` reads an Entry's body with to render History. A Reference, a list, or a checkbox
is therefore defined in exactly one place and read on exactly one path whether the Composer is
opening an Entry for editing or History is merely displaying it. Lexical has no notion of parsing
Markdown into its own node tree out of the box; adopting it would have meant writing a second
grammar as a set of Lexical transformers, alongside `inline-markdown.ts`'s own — two parsers for one
dialect, the exact risk ADR 0043 and `inline-markdown.ts` both already refused once. ProseMirror's
`entry-schema.ts` (issue #154) is deliberately a mirror of `InlineNode`/`EntryBlockNode`'s own shape
— `strong`/`em`/`code`, `bullet_list`/`ordered_list`/`list_item`, a nullable `checked` — precisely so
this stays one grammar with two representations of the same tree, not two grammars.

**UpNote's "you never see syntax" feel is real and achievable, and it is a SEPARATE goal from
"Markdown is what is stored."** Verified by inspecting the shipped application: UpNote stores HTML in
SQLite (a `notes` table, an `html` column; 278 of 326 sampled rows begin with `<`) behind a bespoke
`contenteditable` editor with no ProseMirror, Lexical, CodeMirror or Slate anywhere in its bundle. It
gets "no visible syntax" by giving up "Markdown is what is stored" entirely. This repo keeps Markdown
as the stored form — `Entry.body` is still a string, Export and the Server still see the same
characters they always did, `PROTOCOL_VERSION` does not move — and pays for that at the boundary
instead: `entryDocumentToMarkdown` is a normalizing serializer, and normalizing is the cost the next
two decisions exist to contain.

**Input rules consume markers as they are typed**, via `prosemirror-inputrules`: `**bold**`, `*italic*`,
`` `code` `` (a small hand-written `markInputRule`, not a second parser — it recognises a typed
delimiter pair and applies a mark, nothing else), `- `/`1. ` (`wrappingInputRule`, from
`prosemirror-schema-list`), and `- [ ] `/`- [x] ` as the composition of two rules — the bullet rule
converts the item first, a second rule then reads `[ ]`/`[x]` typed at that item's own start and sets
`checked` on the `list_item` via `setNodeMarkup`. `prosemirror-inputrules`' own `view.composing`
guard is untouched — see "the known upstream limitation" below for why that specifically matters.

A real defect surfaced only by typing character-by-character in an actual browser, not by any unit
test: input rules re-run on EVERY keystroke, and `**bold**` typed one character at a time passes
through the state `**bold*` — one closing asterisk short — which a naive `` /\*([^*]+)\*$/ `` em
pattern genuinely matches, turning "bold" italic before the second closing `*` ever arrives.
`composer-editor.ts`'s em rule guards this with a negative lookbehind, `(?<!\*)`, so an opening `*`
immediately preceded by another `*` is never read as an em delimiter. jsdom cannot exercise this at
all (see "Tests" below); it was caught by driving a real Chromium instance by hand.

**Enter is `chainCommands(splitListItem, liftListItem)`, then `baseKeymap`'s own paragraph split** —
`prosemirror-schema-list`'s own doc comment names exactly this composition: `splitListItem` splits a
non-empty item, and deliberately returns `false` on an empty top-level one ("bail out and let next
command handle lifting"), which is what makes chaining `liftListItem` right after it correct rather
than redundant. Outside a list both return `false` and the key falls through — two separate
`keymap()` plugins registered in order, not one merged bindings object, since ProseMirror tries each
plugin's `handleKeyDown` in turn and only advances on `false`. `Shift-Enter` needed its own binding
for a reason worth recording: `prosemirror-keymap` only falls back from a Shift-modified name to the
bare one for single-character keys ("a" falling back from "Shift-A"), never for a named key like
"Enter" — verified by reading its source, not assumed — so a keymap defining only `Enter` is never
even consulted for `Shift-Enter`. Left unbound, the keystroke reached the browser's own native
contenteditable behaviour (typically a bare `<br>`), which `entrySchema` has no node for at all, so
ProseMirror's DOMObserver reconciled the DOM straight back to the real document on its next update
and the keystroke silently vanished — worse than before, where a plain `<textarea>` inserted an
honest `\n` for both Enter and Shift+Enter alike (issue #76). `Shift-Enter` is now bound to the same
list chain plus `splitBlock` as its own fallback, so it behaves like Enter everywhere Enter does; the
ticket's own requirement — Shift+Enter must never send — holds regardless, since `isSubmitChord`
already excludes it before either keymap is reached.

**`prosemirror-history` replaces the native `<textarea>` undo**, bound to `Mod-z`/`Shift-Mod-z`/`Mod-y`.

**The `[[` picker is ported, not rewritten.** `derivePicker`, `buildDateSuggestions`, `chooseItem`'s
logic and the dropdown UI move to `composer-picker.ts` unchanged in substance — same regex-free state
machine over a flat string and a caret index. What changes is only trigger detection: a ProseMirror
plugin (`pickerPlugin`, `composer-editor.ts`) rebuilds that same "flat text plus a caret index" shape
from the current textblock on every transaction — an inline atom (a Reference) contributes exactly
one placeholder character, keeping a doc position and a string index in the exact 1:1 correspondence
`derivePicker`'s own contract already assumed — and hands it to the untouched function. Choosing a
suggestion inserts a live `reference` node via a transaction (`entrySchema.nodes.reference.create`),
not literal bracket text, so it renders as a Reference immediately rather than sitting as inert
characters until the next parse; `insertAtCursor` (the "Refer" action's own imperative handle)
recognises the same two literal shapes `pickerItemMark` ever produces and does the same. `insertAtCursor`'s
old body — the `flushSync` + `setSelectionRange` hack a real DOM caret needed — and its sibling
`commitInsertion` are deleted outright; a ProseMirror transaction replaces both.

**Dirty-only commits.** `entryDocumentToMarkdown` normalizes: reformats escaped markers, may reflow a
mark's nesting order (see that file's own `localMarkRank`), and always produces the SAME canonical
text for equivalent documents. Committing an Entry that was merely opened and closed — never
genuinely edited — would rewrite its bytes to that canonical form, Sync the rewrite, and mark the
Period's Digest stale (ADR 0039) for an Entry nobody touched. `docChanged` on a ProseMirror
transaction is the one signal that distinguishes "the reader clicked in and back out" from "the
reader actually typed something" — comparing before/after Markdown text cannot do this, since a
normalizing serializer can make an untouched Entry's round-trip look identical OR different from its
stored text for reasons that have nothing to do with editing. `dirtyRef` in composer.tsx tracks it,
reset every time the document is (re)loaded; `decideSend` (`composer-send.ts`, a pure function,
unit-tested directly) reads it and treats an unchanged edit as a Cancel — same exit path a real
Cancel takes, restoring the same pre-edit draft, rather than a parallel "silently do nothing" branch.

**The Composer grows to 8 lines, not 5** (`max-h-[13.125rem]` — 8 × 24px line-height + 16px padding +
2px border = 210px), because a checklist outgrows five lines immediately. The arithmetic constraint
from the pre-#155 Composer is unchanged and restated where the new value lives: the ceiling must be
a whole number of lines plus padding and border, or the field clips its own last line horizontally
through the glyphs.

## Tests

jsdom implements no `Range`, no `Selection`, and no meaningful `getBoundingClientRect` — a
ProseMirror `EditorView` cannot usefully mount in it, and none of this ticket's own tests try. What
stayed pure moved to its own module and IS still unit-tested there: `composer-picker.ts` (the
picker's state machine and suggestion-building, `composer-picker.test.ts`) and `composer-send.ts`
(dirty-only-commit and whitespace-refusal, as one decision function, `composer-send.test.ts`).
`composer.test.tsx`, which drove the old `<textarea>` through `fireEvent`, is deleted rather than
adapted — there is no DOM interaction left in `composer.tsx` a jsdom test could still reach.
`composer-page.test.tsx` keeps its own coverage of the Edit/Refer/seek wiring (it never types into
the field, only sets `editingEntry` through the same state the real page uses), adjusted only where
it asserted through `<textarea>`-specific matchers (`toHaveValue`, `toBeDisabled`) that a
`contenteditable` `<div>` cannot satisfy — `textContent` reads and `aria-disabled` checks replace
them respectively.

Real typing, caret behaviour, the picker, list Enter/lift, and the Send chord move to
`apps/e2e/tests/composer.spec.ts`, against a real browser. `apps/e2e/tests/helpers.ts`'s `sendEntry`/
`editEntryViaMenu` switch from `.fill()` to `.pressSequentially()`: `fill()`'s bulk DOM write on a
`contenteditable` bypasses the `beforeinput`/`handleTextInput` path input rules are built on
entirely (verified live — a `.fill()`'d `**bold**` stays four literal asterisks), where every other
spec in the suite that sends or edits an Entry passes through those same two helpers and needed no
changes of their own.

## Alternatives considered

- **Lexical.** Rejected primarily on the one-grammar property above, not on its own gzip weight
  (123 KB, worse than ProseMirror but not disqualifying on its own): it has no Markdown grammar of
  its own, so adopting it would have meant a second parser for `[[…]]` References and lists,
  maintained in step with `inline-markdown.ts` by hand — exactly the drift ADR 0043 already refused
  once for the render path.
- **Tiptap 3.** ProseMirror underneath, so the one-grammar argument is neutral either way; rejected
  on its own added weight (143 KB core + 50 KB for markdown round-trip, both on top of the
  ProseMirror it wraps) for extension machinery — a fluent API for editors juggling many optional
  extensions — this Composer, with a fixed and small mark/node set, does not need.
- **CodeMirror 6.** A code/text editor, not a rich-document one; an Entry's marks and lists would be
  a second, home-grown layer bolted on top rather than something the engine already models.
- **BlockNote.** The right shape (blocks, marks, a document) at 419 KB — six times ProseMirror's own
  weight — for a block-switching, drag-handle, slash-command UI an Entry (ADR 0043: "still untitled
  and unorganized") has no occasion to use.
- **A CSS-only "hide syntax near the caret" trick over the existing `<textarea>` (Obsidian's own
  approach).** Obsidian hides syntax only while the caret is off the line, over a real Markdown file
  on disk; it does not solve "formatting appears as you type," which is what issue #155 actually
  asked for, and a `<textarea>` still has nowhere to attach "this run is bold" without a second,
  hand-synchronized representation.
- **Round-trip a checkbox tick through the Composer's own document, instead of `toggle-task.ts`'s
  splice (ADR 0043 already made and restates this choice).** Rejected for the reason ADR 0043 already
  gives: every tick would re-serialize the whole body, so merely reading and ticking History would
  normalize Entries the reader never opened the Composer for at all — the Composer stays the ONLY
  thing in the app that can normalize a body, and only when it is genuinely used to edit one.

## Consequences

**A body can now be edited without ever being retyped by hand, and every edit passes through the
same normalizing serializer.** An Entry's characters survive verbatim until the day it is genuinely
edited (dirty-only commits, above); the day it is, its stored text becomes whatever
`entryDocumentToMarkdown` canonically produces for that document — not necessarily byte-identical to
what a person would have typed by hand for the same meaning, the same normalization ADR 0043 already
accepted for a checkbox splice, now generalized to a full edit.

**The known upstream limitation: `prosemirror/prosemirror#1072`, open six years.** Marks can fail to
apply mid-word during Android IME composition — a composing run is provisional, uncommitted text the
OS may still revise, and ProseMirror's own transaction model does not always reconcile an input
rule's mark against it correctly. `prosemirror-inputrules` guards against the worst of this itself:
its `run()` function returns `false` immediately `if (view.composing)`, deferring to `compositionend`
to re-run the same rules once the OS has committed final text — this ticket does not touch that
guard, and issue #156 depends on it staying intact. Issue #156 is the on-device verification gate for
this limitation specifically, with a prepared fallback already scoped if it proves to matter in
practice: disable the mid-word inline rules (bold/italic/code) on Android only, keeping the
line-start rules (list/checkbox markers, which trigger on a trailing space rather than mid-word and
are far less exposed to this class of bug).

**That gate has now been run, and the fallback was not needed.** Verified on a physical Android
device (vivo I2301, Android WebView, Gboard) against the Sandbox build, driving the on-screen
keyboard itself — tapping its keys, so the OS opens a real composing region — rather than injecting
text through `adb shell input text`, which commits directly and would have proved nothing about
composition at all. Typing `foo**bar**` with no space before the marker, so the mark opens mid-word,
produced `foo` followed by a bold `bar` with the asterisks consumed, while Gboard's own suggestion
strip was actively offering completions across the whole run. Autocorrect was confirmed live in the
same way: `teh` typed by key taps left the word composing with `the` offered in the strip, and
committed cleanly on space. Bullet, ordered and checkbox rules were confirmed on the same device, as
was ticking a rendered checkbox in History and the tick surviving a restart of the app.

Two of issue #156's criteria remain genuinely unverified, and are called out rather than implied:
**swipe typing**, and **a keyboard other than Gboard**. Neither can be driven from `adb` — swipe is a
continuous gesture the IME interprets itself, and a second keyboard has to be installed and selected
by hand — so both need a person at the device. Nothing found so far suggests they will fail, but that
is an expectation, not a result.

**Two NodeViews exist purely to fill in rendering `entry-schema.ts` (issue #154) never needed to
supply, since it was built with no `EditorView` in sight.** `paragraph` and `reference` have no
`toDOM` in the shared schema at all; `list_item` inherits a working one from `prosemirror-schema-list`
but knows nothing of this schema's own `checked` attribute. `composer-editor.ts` supplies a
`paragraphNodeView`, a `listItemNodeView` (the visible checkbox — mirroring `entry-prose.tsx`'s own
`renderListItem` styling so a task item looks identical composed or read), and a `referenceNodeView`,
rather than adding `toDOM` to the shared schema — keeping `entrySchema` itself free of anything
view-specific, since `entry-document.ts`'s own round-trip tests build documents against that exact
schema with no view in sight at all. A second real defect surfaced only by rendering in a browser: a
task item's checkbox, styled with the SAME `-ml-5` negative margin `entry-prose.tsx` uses safely in
an unconstrained bubble, was silently pushed outside its own clickable area in the Composer
specifically — `overflow-y-auto` (needed for the 8-line scroll ceiling) forces `overflow-x` to compute
as `auto` under the CSS overflow spec's own axis-coupling rule, which clips left-pulled content
instead of letting it bleed harmlessly into padding the way an unconstrained container does.
`apps/e2e/tests/composer.spec.ts`'s own `locator.click()` — real coordinate-based hit-testing —
caught it; the negative margin is dropped for the Composer's own checkbox, trading tight
bullet-alignment for a control that is always exactly where it is drawn.
