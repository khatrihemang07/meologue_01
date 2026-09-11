# 0070: The Composer keeps Tab; Shift-Tab in bare prose is the keyboard exit

## Status

Accepted. Builds on [0044](0044-the-composer-holds-a-document.md), whose own `listKeymap` gave Tab
its very first binding in this Composer (`indent.run`, `sinkListItem`) and, in the same breath,
recorded the reasoning this ADR now revisits: "a Composer that swallowed Tab unconditionally would
be a keyboard trap (WCAG 2.1.2), unable to hand focus back to the rest of the page at all from
inside a list." That reasoning is not wrong here — it is exactly why Shift-Tab, not Tab, is where
this ADR puts the exit. Depends on [0072](0072-upnote-is-the-specification-per-input-modality.md),
which names UpNote's own observed behaviour the specification "only within the input modality it
was captured on" and reserves a category for a behaviour this repo diverges from on the record
rather than copies: this ADR is the first divergence in that category that is not about UpNote
losing content, and it extends 0072's own reasoning to say why a modality difference — not a
destructiveness difference — is grounds enough on its own. Issue #233 is the ticket; the other half
of the same ticket is [0071](0071-a-lone-first-item-indents-under-an-empty-parent-item.md), which
fixes indenting itself rather than what happens once indenting has nothing left to do.

## Context

`docs/reference/upnote-macos-detail.md`'s Gap sweep Group B6 and `docs/reference/upnote-editor-behaviour.md`'s
own pre-existing Tab/Shift-Tab table agree on what UpNote's Tab does outside a list: it inserts a
literal U+2003 EM SPACE at the caret and keeps focus inside the note — confirmed live, via a
`System Events` frontmost-process check taken immediately after the keypress, that focus never once
left UpNote's own window. Group B3 confirms the mirror image for Shift-Tab on the same plain prose:
a pure content no-op, byte-for-byte unchanged, that ALSO never moves focus. Tab, in other words, is
never a focus-navigation key anywhere in UpNote — not once, on either platform, in any of the
gap-sweep sessions that drove it by hand.

This repo's own Composer, before issue #233, did the opposite outside a list: `indent.run`
(`sinkListItem`) has nothing to sink in plain prose and returns `false`, and 0044's own `listKeymap`
comment names exactly what that `false` does next — it reaches `prosemirror-keymap`'s own handler
having never called `preventDefault`, so the browser's native Tab runs unopposed and focus moves to
whatever is next in the page's own tab order. `apps/e2e/tests/composer.spec.ts`'s own (now
superseded) "Tab outside a list still moves focus out of the Composer, not swallowed as a keyboard
trap" asserted precisely this, and asserted it for a real reason: at the time 0044 wrote that
comment, this was the one Tab binding this Composer had, and letting it fall through was the only
way a keyboard user could ever leave a Composer that was, at that point, not yet sitting ahead of
any other focusable control worth reaching.

That premise stopped holding once issue #164's Format toolbar and this app's own Send button landed
between the Composer field and the rest of the page in DOM order. A forward Tab from inside the
Composer's own field, with 0044's own binding still in place, does not leave the Composer for "the
rest of the page" in the abstract — it lands on the very first control the ticket's own toolbar
comment already knows about, the Format toolbar toggle. That is a real destination, not a trap by
itself. The trap 0044 was actually guarding against was never "Tab does nothing" — it was "Tab does
nothing, AND there is no OTHER way out of the field either." Once this ADR makes Tab itself
unconditional (below), that second half of the guard is what has to move somewhere, or the very
failure mode 0044 named would reappear in the opposite direction: a Composer a keyboard user can tab
INTO but never tab back OUT of the same way, because forward Tab, now swallowed everywhere by
design, is no longer available to retreat with either.

## Decision

**Tab is swallowed unconditionally, everywhere in the Composer, matching UpNote's own observed
keystroke exactly.** `indent.run` (composer-commands.ts, extended by 0071 to also handle a list's
first item) already returns `true` and stays inside the document whenever there is something to
sink; `insertEmSpace` (composer-commands.ts) is the fallback for every position that is not: it
always returns `true`, inserting a literal U+2003 EM SPACE at the caret and dispatching a plain
transaction, the same "no `handleTextInput`, so it can never re-trigger an input rule" shape 0066's
own `insertSoftBreak` already established for Enter outside a list. `listKeymap`'s own `Tab` binding
becomes `chainCommands(indent.run, insertEmSpace)` — two commands tried in order, the second of
which cannot itself fail, so `Tab` in this Composer now returns `true` from every reachable caret
position and `prosemirror-keymap` never falls through to a native key handler for it at all.

**Shift-Tab keeps `outdent.run` (`liftListItem`) for every in-list case, unchanged, and gains
exactly one new fallback: delete one PRECEDING U+2003 EM SPACE, if the caret sits immediately after
one.** `outdentEmSpaceOrExit` (composer-commands.ts) reads `$from.nodeBefore`, checks it is a text
node whose own text ends in the em space character, and deletes exactly that one character when it
does — undoing precisely what `insertEmSpace` above just inserted, the same "Backspace undoes the
input rule that just fired" shape `undoInputRule`/issue #210 already gave this Composer for a typed
list marker. When there is no such character to undo, `outdentEmSpaceOrExit` returns `false`
unchanged, and THIS is the one place in the whole `listKeymap` where reaching
`prosemirror-keymap`'s own native fallback is still deliberate: `listKeymap`'s own `Shift-Tab`
binding is `chainCommands(outdent.run, outdentEmSpaceOrExit)`, and a caret in bare prose with
nothing to undo is the one case where both commands genuinely have nothing left to do, so the
keystroke reaches the browser's own backward focus navigation exactly the way Tab used to for every
case before this ticket.

**This is a deliberate divergence from UpNote, not an oversight, and it sits in a fourth category
0072 does not yet name.** The three divergences 0072 already records — a multi-block Tab's own lost
text, the toolbar un-list collapsing three items to one, the alternating un-nest — are all cases
where copying UpNote would LOSE something the person typed. Nothing here is lost: the document under
Shift-Tab's fallback is byte-for-byte the same either way, exactly as UpNote's own B3 finding already
is. What differs is not content, it is REACHABILITY. UpNote's Tab never had to double as a focus-exit
key because UpNote's own editor is the whole application surface — there is nothing after it in any
tab order for a keyboard user to reach by leaving. This Composer is an `<input>`-shaped surface
embedded in a page that has a Format toolbar and a Send button positioned after it in DOM order,
which UpNote's own note editor was never built to be. 0072's own "UpNote is the specification, but
only within the input modality it was captured on" already draws exactly this kind of boundary for
macOS versus Android; this ADR draws the same kind of boundary again, one level up — between "a
dedicated note-taking application" and "one field inside a larger page" — and finds UpNote's own
Tab/Shift-Tab pair does not straightforwardly transplant across it.

## Alternatives considered

- **Copy UpNote exactly: Tab always inserts an em space and keeps focus, Shift-Tab is always a
  content-only no-op, focus never moves either way.** Rejected as the literal keyboard trap 0044's
  own comment already named: with Tab swallowed everywhere and Shift-Tab ALSO never yielding to
  native focus navigation, a keyboard user who tabs into the Composer field has no way to leave it
  by keyboard at all, in either direction — worse than the pre-233 behaviour this ADR replaces, not
  equivalent to it.
- **Keep the pre-233 behaviour: Tab falls through to native focus navigation outside a list,
  Shift-Tab does too.** Rejected as the reported defect itself once 0071 makes Tab actually sink a
  list's first item: a Composer where Tab sometimes indents and sometimes silently leaves the field
  depending on caret position is worse than either extreme, and it is also simply not what UpNote
  does — Group B6 is unambiguous that Tab never moves focus there, empty note included.
- **Bind the exit to Escape instead of Shift-Tab**, leaving Shift-Tab as a pure UpNote-matching
  content no-op with no focus behaviour of its own. Rejected: Escape already has a job in this
  Composer (dismissing the `[[` picker and the `/` menu, composer.tsx), and overloading it with "also
  leave the field" when neither menu is open would be a second, harder-to-discover way to leave that
  duplicates what Shift-Tab already does everywhere else a reader expects Tab/Shift-Tab to be a
  matched pair.
- **A visible, separate "leave the field" control** (a button, or an `aria-keyshortcuts` hint).
  Rejected as solving a problem this ADR's own mechanism already solves for free: Shift-Tab already
  reads naturally as "the reverse of Tab" to anyone who has ever tabbed through a form, and a bare
  prose caret with no em space to undo is common enough (any Composer session that has not yet
  pressed Tab at all) that the exit is reachable on the very first Shift-Tab press for most readers,
  not buried behind a UI affordance nobody asked for.

## Consequences

**Tab, in this Composer, now means exactly one of two things depending on caret position — sink a
list item (0071), or insert an em space — and never a third, "do nothing and hand focus away."**
`apps/e2e/tests/composer.spec.ts`'s three replacement cases for the superseded "Tab outside a list
still moves focus" test assert this directly: Tab in bare prose inserts the em space and keeps
focus, Shift-Tab right after undoes it and keeps focus, and Shift-Tab with nothing to undo is the
one case focus still moves — the same three-way split this Decision describes, proven against a
real browser rather than reasoned about in the abstract, per ADR 0044's own "Tests" section on why
this class of behaviour cannot be proven in jsdom at all.

**A reader who never touches a list can still always reach the Format toolbar and Send button by
keyboard — just via Shift-Tab-then-Tab, or by clicking, rather than a single forward Tab.** This is
a real, deliberate cost: the pre-233 Composer let a single Tab press reach the toolbar directly from
bare prose, and this ADR removes that path in favour of matching UpNote's own Tab exactly. Nothing
about reaching the REST of the page's own navigation is harder than before — Shift-Tab still reaches
it in one press from a caret with no em space to undo, the overwhelmingly common case for anyone who
has not yet pressed Tab in that session — but a reader who deliberately wants the OLD one-press
forward path no longer has it, traded for parity with UpNote's own keystroke.

**`insertEmSpace`/`outdentEmSpaceOrExit` are the second and third commands in this codebase, after
`insertSoftBreak` (0066), that dispatch a plain document-editing transaction specifically so a
keystroke can never re-trigger `prosemirror-inputrules` on its own output.** Any future keystroke
that inserts or deletes a single, load-bearing character — the way an em space now is — has this
same shape already established to copy, rather than needing to rediscover why `handleTextInput`
would be the wrong path for it.
