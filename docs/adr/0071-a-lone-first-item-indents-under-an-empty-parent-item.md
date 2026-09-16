# 0071: A lone first item indents under an empty parent item

## Status

Accepted. Builds on [0044](0044-the-composer-holds-a-document.md), which chose `entry-schema.ts`'s
`list_item: "paragraph block*"` content model — a nested `bullet_list`/`ordered_list` living INSIDE
the `list_item` it belongs to — as the shape `prosemirror-schema-list`'s own commands
(`splitListItem`/`liftListItem`/`sinkListItem`) are documented to expect. This ADR is the first time
that choice runs into a case `sinkListItem` itself cannot reach at all, for a structural reason
rather than a bug in it. Depends on
[0072](0072-upnote-is-the-specification-per-input-modality.md), which names UpNote's own
`upnote-editor-behaviour.md`/`upnote-macos-detail.md`/`upnote-android-detail.md` findings the
specification this ADR matches. [0070](0070-the-composer-keeps-tab-and-shift-tab-in-bare-prose-is-the-keyboard-exit.md)
is the other half of issue #233: that ADR decides what Tab/Shift-Tab do once there is nothing left
to indent or outdent; this one decides what indenting itself does for the one case that was
previously impossible.

## Context

**This is the reported defect.** Pressing Tab on the FIRST item of a list in the Composer moved
focus to the Format toolbar instead of nesting the item — the exact failure 0070 traces to a `false`
return reaching `prosemirror-keymap`'s native fallback — and it is the case a person hits first,
since it is the very first Tab press in any brand-new list. The cause is named directly in
`prosemirror-schema-list`'s own source: `sinkListItem`'s implementation checks `if (startIndex == 0)
return false` before doing anything else, because sinking a list item means wrapping it as the sole
child of a NEW `list_item`, itself spliced in as the LAST child of the item immediately PRECEDING
it — and an item at index 0 has no preceding sibling to splice into. Every item after the first
already works today, which is precisely why the defect is easy to miss in review and easy to hit in
practice: the first thing anyone does with a brand-new two-line list is try to nest the second line
under the first, and only later — often not at all — try nesting the first line itself.

`upnote-editor-behaviour.md`'s own Lists table states plainly that UpNote has no such gap: "Tab on
the first item of a list | also nests, producing `<ul><ul><li>…`." `upnote-android-detail.md`'s Gap
sweep Group D confirms the identical result independently on the other platform ("This matches macOS
exactly"). The reason UpNote has no gap here at all, rather than a differently-shaped one, is
structural, not a difference in polish: `upnote-editor-behaviour.md`'s own module comment states it
directly — "Nesting is emitted as a `<ul>` that is a *sibling* of the `<li>`, not a child of it" —
`<ul><li>one</li><ul><li>two</li></ul></ul>`, invalid per the HTML spec, and exactly what UpNote's
shipped editor writes anyway. Nesting a lone item under THAT shape needs no wrapper at all: the
attachment point is the enclosing `<ul>` tag itself, which already exists and needs nothing spliced
into any `<li>` to hold a new sibling `<ul>`. `entrySchema`'s own content model, chosen by 0044 for
good and unrelated reasons — mirroring `prosemirror-schema-list`'s own documented recommendation,
keeping `EntryBlockNode`'s shape in the schema, letting `splitListItem`/`liftListItem` work at all —
cannot express UpNote's sibling shape: `bullet_list`'s content is `"list_item+"`, so a `bullet_list`
can only ever appear as a CHILD of some `list_item`, never as a bare sibling inside another
`bullet_list`. The gap `sinkListItem` refuses to cross is therefore not a missing feature of that
command; it is the one case where this schema's own child-nesting shape has, structurally, nowhere
to put a lone item's own nested list at all.

## Decision

**`sinkFirstListItem` (composer-commands.ts) wraps the item in a newly created, otherwise-empty
PARENT `list_item` — its own leading paragraph carrying no text, `checked: null` — whose only other
content is a fresh nested `bullet_list`/`ordered_list` (matching the original list's own type)
holding the original item, now one level deeper.** This is the schema-legal stand-in for UpNote's
sibling `<ul>`: where UpNote attaches a lone item's nested list directly to the enclosing tag, this
schema attaches it to a `list_item` built to hold nothing else. An **empty parent item** is this
ADR's own name for that wrapper — a `list_item` whose entire reason for existing is to satisfy
`entrySchema`'s own "a nested list lives inside a `list_item`" rule for a nesting UpNote's shape
never needed a container for at all.

`indent.run` (composer-commands.ts) becomes `chainCommands(sinkListItem(listItemNodeType),
sinkFirstListItem)`: plain `sinkListItem` still runs first and still owns every case it already
handled (an item WITH a preceding sibling), and `sinkFirstListItem` only ever reaches the document
when that first command has already refused — its own guard, `$from.index(itemDepth - 1) !== 0`,
returns `false` immediately for any item `sinkListItem` would have accepted, so the two commands
partition the caret positions where indenting is possible into disjoint cases rather than racing
each other or double-nesting anything. Binding this at `indent.run` itself, not only at the `Tab`
keymap entry, means the Format toolbar's own Indent button (issue #164) and any future `/`-menu
entry for the same action inherit the fix automatically — every caller already goes through this one
registry entry, per composer-commands.ts's own module comment on why the registry exists at all.

**The transaction reuses the original item node unchanged, rather than rebuilding it, and computes
the caret's new position directly rather than mapping it through the transaction's steps.**
`state.tr.replaceWith(itemStart, itemEnd, emptyParent)` replaces exactly the original item's own
range with the new empty-parent node, which carries that same original item — with every mark,
nested block, and `checked` state it already had — as the nested list's only child. Because the
original node is reused byte-for-byte as a descendant of the new parent, ANY position that used to
fall inside the old item's own range maps to the identical position plus one fixed offset: the size
of everything now inserted ahead of it — the parent's own opening token, its empty leading
paragraph in full, and the new nested list's own opening token — computed from the real node sizes
at runtime (`1 + emptyParagraph.nodeSize + 1`) rather than a hard-coded magic number, so the
arithmetic stays correct even if `entry-schema.ts`'s own paragraph shape ever changes.

**The empty parent renders markerless — no bullet, no number — matching the fact that it holds no
text of its own.** `index.css`'s own `.ProseMirror` rules gain a structural selector: an `<li>` whose
content `<div>` starts with a `<p>` holding nothing but `prosemirror-view`'s own auto-inserted
`<br class="ProseMirror-trailingBreak">` (confirmed live against a real sunk-first-item's own DOM,
not assumed — an empty ProseMirror textblock is never rendered with zero children at all, since a
browser needs SOMETHING to place a caret against), or genuinely `:empty`, immediately followed by
the nested `<ul>`/`<ol>` that empty paragraph exists to hold, gets `list-style: none`. Because CSS
Selectors 4 refuses a `:has()` nested inside another `:has()`'s own argument — verified directly,
not assumed, as a real `SyntaxError` thrown by a live browser rather than a test-only failure — the
"holds only a trailing break" shape is expressed as two separate, UNnested `:has()` clauses chained
onto the same `<li>` (an implicit AND) rather than one clause trying to inspect the paragraph from
two directions inside a single argument. An ORDINARY empty list item — one a reader left blank by
pressing Enter twice, with no nested list following it — still shows its marker exactly as before:
the selector's own `+ :is(ul, ol)` half is what confines this rule to a wrapper that exists
specifically to hold a nested list, never to "any empty item," which is UpNote's own behaviour too
(an empty note is still `<br>`, a bare, markerless line — but an empty non-wrapper list item keeps
its bullet).

## Alternatives considered

- **Give `entrySchema`'s `list_item` its own sibling-list content model, matching UpNote's shape
  exactly.** Rejected without being seriously pursued: `entry-schema.ts` is deliberately out of this
  ticket's own file ownership, and changing `bullet_list`'s content from `"list_item+"` to something
  that also accepts a bare nested list would ripple into `entry-document.ts`'s serializer,
  `entry-prose.tsx`'s reader, and the 691-case round-trip corpus 0044 already leans on — a change
  with a blast radius far past what fixing one Tab keystroke needs, for a shape
  `prosemirror-schema-list`'s own commands were never written to expect either.
- **Silently do nothing on a first-item Tab, rather than either nesting it or falling through to
  native focus navigation.** Rejected as strictly worse than either extreme: it neither matches
  UpNote (which nests) nor preserves the pre-233 accessibility behaviour (which at least moved focus
  somewhere reachable) — a keystroke that visibly does nothing at all is the one outcome nobody
  reading this Composer's own `listKeymap` comment would call correct.
- **Reuse `wrapInList` (`prosemirror-schema-list`) directly, rather than a hand-written
  `replaceWith`.** Investigated and rejected: `wrapInList` builds a NEW list wrapping the CURRENT
  selection's own range, which is the right shape for turning plain prose into a list in the first
  place (`composer-commands.ts`'s own `bulletList`/`orderedList` toggle already uses it for exactly
  that), not for wrapping one EXISTING `list_item` — already itself inside a list — in a new PARENT
  item nested one level deeper within the SAME list. Reaching for it here would have meant fighting
  its own assumptions about what is being wrapped rather than writing the several, more direct lines
  `sinkFirstListItem` actually needs.
- **Skip the empty parent entirely and give the sunk item a `level` attribute instead**, rendering
  indentation purely as a CSS `margin-left` multiple with no structural nesting at all. Rejected: it
  would abandon `entry-schema.ts`'s own tree-shaped nesting (every other list depth in this Composer
  already IS structural, not an attribute) for one special case, and `entryDocumentToMarkdown` has no
  Markdown spelling for "this item is at level 2" outside of actual list nesting — the serializer
  would need a parallel, level-attribute-aware code path solely for items sunk this one way.

## Consequences

**`meologue-reference/upnote-macos-detail.md`'s own Gap sweep Group B1's "Tab on the first item of a
list also nests" finding, and `upnote-android-detail.md`'s Gap sweep Group D confirming the same on
Android, are both now true of this Composer as well — proven live, not merely reasoned about: a
real browser was driven by hand through exactly this scenario (a two-item list, caret moved back to
the first item, Tab pressed) before this ADR was written down, and the resulting DOM was inspected
directly rather than assumed from reading the code.**

**A known gap this ticket's own file ownership deliberately leaves open: the markerless rendering
above is Composer-only.** `entry-prose.tsx`'s read-only History render has its own, separate list
renderer (`renderListItem`/`renderBlocks`), untouched here — issue #233 explicitly scopes the
read-only markerless rendering to a later ticket, so a Sent Entry whose body already contains this
exact shape (from an edit made through this fix, or any future path that builds one) renders WITH a
visible bullet beside an empty line in History today, even though the Composer that wrote it showed
none. This is a real, temporary inconsistency between the two render paths this repo's own
`index.css`/`entry-prose.tsx` comments already warn must be kept in step "by hand," recorded here
rather than left to be rediscovered as a surprise.

**`CONTEXT.md`'s own glossary does not yet define "empty parent item," and this ticket does not
add it there either — `CONTEXT.md` is outside issue #233's own file ownership, deliberately, since
another ticket is editing the read-side files this term's own render behaviour touches at the same
time.** The term is coined and used consistently in this ADR and in `composer-commands.ts`'s own
`sinkFirstListItem` comment, so a future glossary pass has a single, already-settled definition to
adopt rather than one it has to invent.

**`apps/web/src/lib/parity/parity-fixture.ts`'s `tab-on-first-item-of-list-also-nests` row compares
this Composer's live document against UpNote's own two-item canonical shape — `[{level: 1, "alpha"},
{level: 0, "bravo"}]`, no third entry — and `apps/web/src/lib/parity/canonical.ts`'s own
`flattenList` (verified directly, by constructing exactly this Composer's own empty-parent shape
against a real `entrySchema` document and reading `entryDocumentToCanonical`'s literal output, not
assumed from reading the algorithm alone) unconditionally pushes ONE `CanonicalListItem` entry for
EVERY `list_item` it walks, the empty parent included, before ever asking whether that item's own
prose is empty.** The live result is therefore three entries — the empty parent, then "alpha" one
level deeper, then "bravo" — not the two the fixture's own `expected` value states, for a structural
reason `canonical.ts` has no mechanism to avoid today: `flattenList` has no notion of "this
`list_item` exists purely as a wrapper, elide it," because nothing before this ADR ever needed one.
UpNote's own sibling-`<ul>` shape never produces a comparable wrapper `<li>` at all — `flattenHtmlList`
(canonical.ts) walks a `<ul>`'s own children directly, where a nested `<ul>` recurses with NO `<li>`
entry of its own — so this is not a case either adapter reads incorrectly; it is a real, load-bearing
difference between "a wrapper the DOM never needed" and "a wrapper this schema's own content model
requires," that `canonical.ts`'s current `flattenList` has no code path to reconcile. Both
`apps/web/src/lib/parity/**` and `entry-schema.ts` are outside issue #233's own file ownership, so
this ADR records the finding — reproduced directly against a real `entrySchema` document, not
inferred — rather than resolving it: a future pass on `canonical.ts` teaching `flattenList` to skip
a `list_item` whose own prose is empty and whose only other content is the nested list it exists to
hold is the natural fix, symmetrical with `flattenHtmlList`'s own existing behaviour, and does not
require touching this ADR's own decision or the document shape it produces.
