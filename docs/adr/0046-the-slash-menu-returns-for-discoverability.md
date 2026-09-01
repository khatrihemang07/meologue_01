# 0046: The slash menu returns for discoverability

## Status

Accepted. **Reopens a refusal recorded in [0044](0044-the-composer-holds-a-document.md)**, which
rejected BlockNote as the Composer's editing engine partly *for having a slash-command menu* — see
Context for the exact sentence and why it does not carry over to a purpose-built one. **Depends on**
issue #160's `composer-commands.ts` registry, which is what makes this menu possible to build
without reimplementing any of the seven actions it offers, and on issue #164's format toolbar, whose
own landing is what surfaces this ADR's problem in the first place (see Context). **Extends**
0044's own pattern of a doc-derived trigger-detection `Plugin` reading a flat string and a caret
index (`pickerPlugin`) — this ADR adds a second, sibling instance of that same pattern
(`slashPlugin`) for a second trigger character, rather than widening the first plugin to understand
two triggers at once.

## Context

0043 gave an Entry a grammar — checklists, lists, References — and 0044 gave the Composer a live
document that renders that grammar as it is typed. Neither ADR gave a reader any way to find out any
of it exists. A checklist is `- [ ] ` or `[] `, typed from memory or not at all. A Reference is
`[[`, typed from memory or not at all. Until issue #164's toolbar landed, there was no button, no
menu, no hint anywhere in the Composer that this dialect was there to use — and the toolbar itself
is off by default (`formatBarVisible` in settings.ts, mirroring UpNote's own default) and only shows
while the field has focus, so even a reader who stumbles onto the toggle has to already be looking
for it. Everything ADR 0043 and ADR 0044 built was real capability with a zero-discoverability path
to it.

This is exactly the gap ADR 0044 itself, four sections later in the same document, refused to close
with a specific, named tool. Quoting 0044's own "Alternatives considered" entry for BlockNote in
full:

> BlockNote. The right shape (blocks, marks, a document) at 419 KB — six times ProseMirror's own
> weight — for a block-switching, drag-handle, slash-command UI an Entry (ADR 0043: "still untitled
> and unorganized") has no occasion to use.

And from the same ADR's "Decision" section, on why BlockNote was refused as the Composer's engine at
all: it is "a finished block-editor product built ON ProseMirror ... for defaults (drag handles, **a
slash-command menu**, full block-type switching) this Entry — deliberately not a document, ADR
0043's own 'untitled and unorganized' — has no use for." That is not an offhand aside. It is 0044
naming a slash-command menu, specifically, as one of three concrete features an Entry was judged to
have no occasion to use, in the same breath that refused the 419 KB library that would have shipped
it for free.

Per `docs/agents/domain.md`'s instruction to flag rather than silently override a conflicting ADR:
**this ADR contradicts that judgment, and reopens it, rather than pretending 0044 never made it.**
The argument for reopening is not that 0044 was wrong about BlockNote — it wasn't, and this ADR
changes nothing about that refusal, which stands entirely on its own weight and one-grammar
reasoning and is untouched here. The argument is that 0044 bundled a judgment about *whether an
Entry needs a slash menu at all* inside a judgment about *whether BlockNote specifically should ship
one*, and those two questions came apart the moment discoverability became the problem actually
in front of this project. 0044 could refuse BlockNote's slash menu for free reasons — it never had
to ask whether a slash menu, on its own, at zero marginal weight (composer-commands.ts already
exists; every action this menu runs already exists; ProseMirror is already the editing engine), was
worth building. It never asked because nothing had yet made "nobody can find any of this" a felt
problem. Issue #164's toolbar is what made it felt: building a *visible* row of buttons for actions
that had been keyboard-only and invisible since 0044 shipped is what exposed, by contrast, how much
of this dialect a reader typing fast prose would simply never discover on their own.

**The other half of 0044's sentence — "ADR 0043's own 'untitled and unorganized'" — already stopped
applying to structure before this ADR was written.** 0043 itself narrowed that phrase, in its own
Context section: "**Untitled** and **unorganized** are not the same property. An Entry that
contains a checklist is still untitled: nobody named it, nothing files it, it is still found by when
it was captured and what it says. Refusing lists never protected untitledness." 0043 kept
"untitled" and dropped "unorganized" for exactly the feature this ADR is about — lists, checkboxes,
References, the seven-item dialect this menu offers a path into. A slash menu that surfaces
`- [ ] `/`1) `/`[[`/marks does not title an Entry, does not file it, does not organize a History of
Entries into folders or notebooks — it only makes the SAME untitled Entry easier to write correctly.
0044's own citation of "untitled and unorganized" against BlockNote's slash menu was importing a
domain constraint that, read against 0043's own narrowing, had already stopped supporting the
conclusion it was being used for.

## Decision

**A second, sibling ProseMirror plugin (`slashPlugin`, composer-editor.ts), not a widened `[[`
picker.** The user considered and explicitly rejected folding this into the existing picker.
composer-picker.ts's own module comment already frames the `[[` picker as a state machine over "a
flat string and a caret index"; `composer-slash.ts` is a second, independent instance of that same
shape rather than a branch inside the first one, because the two triggers share a SILHOUETTE (an
absolutely-positioned dropdown, opened by a fixed character sequence, narrowed by a query) but not a
GRAMMAR. The `[[` picker's query can be almost anything a date or a free-text search term needs to
be, including a literal space, and closes only on `]` or a newline. The `/` menu's query is always a
single command name typed a few characters at a time, and closes on the FIRST space. Threading both
rulesets through one `derivePicker` would have meant branching most of its logic on which trigger
opened it — clearer to keep as two small modules than to make one file's rules conditional on which
of two callers is asking.

**Obsidian's trigger rule — the beginning of a line, or immediately after whitespace — not UpNote's
fire-anywhere.** Both were live options; the ticket that scoped this feature named the choice
explicitly and it is restated here because it is a real design decision, not an implementation
detail. UpNote opens its own equivalent on every bare `/`, anywhere. An Entry is fast prose typed at
speed, and `and/or`, `w/`, and a bare date like `9/1` are all ordinary things to type into one; firing
a menu on every one of them would mean dismissing an unwanted popup as a routine cost of writing a
sentence with a slash in it. `deriveSlashMenu` (composer-slash.ts) enforces this with
`isTriggerPosition`: the character immediately before the `/` must be whitespace, or the `/` itself
must be the first character of the block. `and/or` is typed, uninterrupted, start to finish, and
never once satisfies that condition, which is verified directly in `composer-slash.test.ts` rather
than left as an assertion about the regex's shape.

**Case- and accent-insensitive, unanchored substring filtering — not fuzzy matching.** This is
UpNote's own actual behaviour, verified against its shipped bundle: its matcher builds a
per-character class with no `.*` between characters, i.e. it tests whether the query occurs
CONTIGUOUSLY inside the label, never whether the query's characters occur in order with gaps
allowed. `/che` therefore matches "Checklist" (a literal substring) and `/chk` matches nothing,
where a fuzzy matcher (the kind a command palette elsewhere in this app, or the OS, might use) would
happily let `chk` skip over the missing `ec`. Accent-insensitivity is `String.prototype.normalize
("NFD")` decomposing an accented character into a base letter plus a combining mark, followed by
stripping every mark in the U+0300–U+036F block — cheap, dependency-free, and sufficient for seven
fixed ASCII-English labels; no locale-aware collation is needed to sort seven things that are never
sorted, only filtered.

**The seven items are reached through `composer-commands.ts`, never reimplemented.**
`buildSlashMenuItems` (composer-slash.ts) looks the seven up by `id` against whatever registry
composer.tsx hands it — `composerCommands` in production, a hand-built stand-in in
`composer-slash.test.ts` — and throws immediately if one is missing, the same throw-on-typo pattern
`composer-commands.ts`'s own `requireNodeType`/`requireMarkType` already established. Choosing
"Bold" from this menu runs the exact same `ComposerCommand.run` the format toolbar's own Bold button
and `Mod-b` both already run; there is exactly one implementation of what each of the seven actions
DOES, and this menu, the toolbar, and the keymap are three different ways of reaching it, never
three different copies of it.

**Mutual exclusion is enforced at the plugin layer, and the Reference picker always wins.**
`slashPlugin` is registered immediately after `pickerPlugin` in `buildComposerPlugins`
(composer-editor.ts), and reads `pickerPluginKey.getState(newState)` — the Reference picker's own
freshly-computed state for the SAME transaction, available because ProseMirror threads the
in-progress `EditorState` through each plugin's state field in registration order — forcing its own
derived state closed whenever that picker is open. Typing `/[[` therefore opens the Reference
picker and never the slash menu, matching the ticket's own explicit requirement ("typing `[[` must
still open the Reference picker") without composer.tsx ever needing to arbitrate between two
independently-open menus: by the time either plugin's state reaches the component, at most one is
ever non-null.

**Zero matches dismisses, and dismissing never touches what was typed.** Unlike the `[[` picker,
which shows "No matching Entry" and stays open at any narrowness, a `/` query that matches nothing
closes the menu outright — composer.tsx's own effect watches the filtered list's length and
dispatches the same `SLASH_DISMISS_META` transaction Escape uses the moment it reaches zero. This,
Escape, and a typed space (`deriveSlashMenu`'s own closing rule) are the menu's three ways to close
without acting, and all three leave the document byte-for-byte as it was: the reader was writing,
the menu offered a shortcut, and declining it — by any of the three routes — must never cost so much
as the trigger character itself.

**Choosing an item deletes the trigger and query, then runs the command — and "Reference" needs no
special case to hand off to the `[[` picker.** `chooseSlashItem` deletes `/query` in one transaction,
then calls the chosen `ComposerCommand.run` against the resulting state in a second — mirroring
`runToolbarCommand`'s own two-step shape (act, then refocus) rather than composer-picker.ts's
`chooseItem`, which inserts a finished node in one step because it always knows exactly what to
insert. Every one of the seven commands works from this same two-step shape unmodified, including
Reference: `reference.run` (composer-commands.ts) always types a literal `[[` at the caret — the
same two characters a hand-typed trigger produces — which land exactly where the deleted `/` span
used to be. `pickerPluginKey`'s own trigger detection opens the Reference picker on the very next
transaction with no code in this feature aware that it just happened; one menu hands off to the
other because typing `[[` always opens it, not because anything here was built to make it so.

## Alternatives considered

- **Folding the `/` trigger into `composer-picker.ts`'s existing state machine**, adding a
  `kind: "slash" | "reference"` discriminant to `ReferencePickerState` and branching `derivePicker`
  on it. Rejected — this was the user's own explicit choice, recorded on the issue, not merely this
  ADR's preference — for the reason given in Decision: the two triggers' closing rules (`]`/newline
  vs. space/newline) and query semantics (near-arbitrary text vs. a single command word) diverge
  enough that unifying them would have made one file's logic conditional on which of two callers was
  asking, trading two small, single-purpose modules for one harder-to-read one.
- **UpNote's fire-anywhere trigger.** Rejected per the ticket's own reasoning, restated in Decision:
  an Entry is prose typed at speed, and `and/or`/`w/`/`9/1` are all ordinary text a fire-anywhere
  trigger would interrupt for no reason. Obsidian's position-gated rule was chosen specifically
  because this app's own domain (fast, low-friction capture) matches Obsidian's stated reason for the
  rule more closely than it matches UpNote's own editing model, even though UpNote is this app's
  closer architectural relative overall (ADR 0044's own "you never see syntax" framing).
- **Fuzzy matching**, the more common shape for a command palette. Rejected in favor of matching
  UpNote's own verified behaviour exactly: substring, not fuzzy — see Decision for the mechanical
  difference and why `/chk` deliberately finds nothing.
- **Greying out (rather than omitting) commands `isEnabled` reports as currently unavailable** —
  `composer-commands.ts`'s own module comment names this as one of three motivating use cases for the
  registry ("a `/` menu ... needs to list which actions currently apply so it can grey out the
  rest"). Deferred, not rejected outright: issue #165's own acceptance criteria never ask for it, and
  in practice all seven actions are enabled from an ordinary caret position in prose (the guard each
  command's `isEnabled` actually exists for — e.g. a mark toggle failing at a document boundary — is
  a narrow edge this menu does not currently surface differently from letting the command's own `run`
  simply no-op). Revisiting this is cheap later: `filterSlashItems` already operates on whatever list
  composer.tsx hands it, so adding an `isEnabled` filter or a disabled visual state is a change local
  to composer.tsx, not to composer-slash.ts's own pure logic.
- **Reopening the REST of 0044's BlockNote refusal along with the slash menu** — drag handles, full
  block-type switching. Explicitly out of scope and not reopened here: this ADR's argument is
  discoverability for the SEVEN actions this Entry's grammar already has, not a case for any
  additional capability BlockNote would have brought. 0044's weight and one-grammar reasoning against
  BlockNote as an engine are untouched; this ADR only revisits the one line item — "a slash-command
  menu" — that discoverability now argues for on its own, built by hand, at effectively zero marginal
  weight, rather than adopted as part of a 419 KB library.

## Consequences

**0044's refusal of a slash-command menu is now narrower than the sentence that stated it.** The
BlockNote refusal itself is untouched — six times ProseMirror's own weight, for defaults this Entry
still has no occasion to adopt wholesale. What no longer holds is the specific claim that a
slash-command menu, on its own, is one of the things "this Entry ... has no use for." It has a use:
the same one the format toolbar (#164) already has, restated for a lower-friction, keyboard-first
path to it.

**The feature cost effectively nothing in bundle weight, which is the concrete proof the two
refusals were always separable.** The android entry chunk measured 60,240 bytes gzip after this
ticket, against the 60,223-byte baseline and 60,228-byte figure 0044 itself recorded, and the same
78,000-byte ceiling — a few bytes of movement, not a new dependency. `composer-slash.ts` is roughly
200 lines of plain string/array logic with no import outside the standard library; `slashPlugin` is
a few dozen lines mirroring `pickerPlugin`'s existing shape; every action the menu runs was already
paid for by issue #160's registry. A slash menu was only ever expensive when it arrived bundled
inside a 419 KB block-editor product — the exact distinction this ADR's Decision draws out of 0044's
one sentence.

**Two independent trigger-detection plugins now read each other's state within a single
transaction**, a pattern this codebase had not needed before this ticket: `slashPlugin` depends on
`pickerPluginKey`'s freshly-computed value for the current transaction, made possible only by
registration order in `buildComposerPlugins`. Any future third trigger (there is no ticket for one)
would extend this same chain rather than needing a new coordination mechanism — but it also means
`buildComposerPlugins`' own plugin order is now load-bearing in a way it was not before, documented
at both the registration call site and in `slashPlugin`'s own comment specifically so a later
reordering does not silently reopen the "both menus at once" bug this ADR closes.

**This ADR is the second time this codebase has reopened its own prior refusal rather than let it
stand as an unexamined precedent** (0043 reopening 0041's inline-only decision is the first).
Both times, the refusal was correct when it was written and stopped being correct only because a
concrete, later-arriving problem — a checklist typed as a run-on paragraph for 0041, a wall of
undiscoverable syntax for 0044 — changed the premise the original decision rested on. Neither
reopening argues the earlier ADR was a mistake; both argue that an ADR's scope is the situation it
was actually reasoned against, and a new situation is grounds to reopen it by name rather than drift
around it by accretion.
