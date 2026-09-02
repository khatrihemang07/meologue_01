/**
 * The ProseMirror wiring issue #155 adds on top of `entrySchema`
 * (entry-schema.ts, issue #154): input rules that consume `**`/`*`/`` ` ``/
 * `- `/`+ `/`* `/`1. `/`1) `/`- [ ] ` as they're typed, a hand-typed `[[…]]`
 * that completes a valid Reference, the list Enter/lift keymap, and the
 * inline `[[` picker's own ProseMirror-side trigger detection.
 *
 * Issue #161 adds two things on top of that: the `*` and `1) ` spellings
 * just listed (CommonMark accepts them as bullet/ordered markers exactly as
 * readily as `-`/`+` and `1. ` — see `parseEntryMarkdown`, inline-markdown.ts
 * — but until now the Composer's own input rules did not, so typing them
 * left literal characters a Send would then have to escape rather than the
 * list structure the reader would have understood), and a one-step `[] `/
 * `[x] `/`[X] ` checklist trigger that skips the two-step `- ` then `[ ] `
 * dance entirely. See the new module comment above `checklistShortcutInputRulePattern`
 * below and ADR 0045 for the full account of why recognition and emission
 * are allowed to diverge here.
 *
 * `prosemirror-markdown` is not a dependency (see entry-document.ts's own
 * module comment and ADR 0044) and none of this reaches for it —
 * `markInputRule` below is a small, hand-written replacement for the one
 * piece of that package's `inputrules.ts` this file actually needed (mark
 * toggling from a typed delimiter pair), not a second Markdown parser.
 *
 * Issue #165 adds `slashPlugin`'s own trigger detection for the `/` menu —
 * built as a second, sibling plugin to `pickerPlugin` rather than folded
 * into it (composer-slash.ts's own module comment explains why the two
 * triggers are a shared SHAPE but not a shared GRAMMAR) — and registers it
 * immediately after `pickerPlugin` in `buildComposerPlugins`, an ordering
 * `slashPlugin`'s own comment explains is load-bearing: it is what lets the
 * `/` menu read the Reference picker's already-computed state for the same
 * transaction and defer to it, per ADR 0046.
 */
import { baseKeymap, chainCommands, splitBlock } from "prosemirror-commands";
import { history } from "prosemirror-history";
import { InputRule, inputRules, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, NodeType, Node as PMNode, ResolvedPos } from "prosemirror-model";
import { splitListItem } from "prosemirror-schema-list";
import { type Command, type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { findWrapping } from "prosemirror-transform";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import {
  bold,
  code,
  indent,
  italic,
  outdent,
  redoCommand,
  toggleCheckboxDone,
  undoCommand,
} from "@/lib/composer-commands";
import { derivePicker, type ReferencePickerState } from "@/lib/composer-picker";
import { deriveSlashMenu, type SlashMenuState } from "@/lib/composer-slash";
import { deviceUtcOffsetMinutes, entryDayKey } from "@/lib/entry-day";
import { entrySchema, type ReferenceAttrs } from "@/lib/entry-schema";
import { parseReferenceDate, parseReferenceEntryId } from "@/lib/inline-markdown";
import {
  type DemotedSignature,
  parseWithDemotions,
  quickAddHighlightClass,
  tokenAtOffset,
  tokenHighlightState,
  tokenSignature,
} from "@/lib/quick-add-highlight";
import { useSettingsStore } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Typed schema access
// ---------------------------------------------------------------------------

/**
 * `entrySchema.nodes`/`.marks` are indexed by plain `string` (entry-schema.ts
 * builds them from `{[name: string]: NodeSpec}`/`MarkSpec` records, not a
 * literal-key union), so under this repo's `noUncheckedIndexedAccess` every
 * access types as possibly `undefined` — even though, for `entrySchema`
 * specifically, it never actually is: nothing here reaches for a node or
 * mark name the schema doesn't define. These two throw rather than return
 * `undefined` so every call site below can treat the result as the real
 * `NodeType`/`MarkType` it always is, and so a typo here fails immediately
 * and loudly (a missing node type breaks the whole editor at construction
 * time) rather than surfacing later as a confusing runtime error deep
 * inside an input rule or a keymap command.
 */
function requireNodeType(name: string): NodeType {
  const type = entrySchema.nodes[name];
  if (type === undefined) {
    throw new Error(`entrySchema has no "${name}" node type`);
  }
  return type;
}

function requireMarkType(name: string): MarkType {
  const type = entrySchema.marks[name];
  if (type === undefined) {
    throw new Error(`entrySchema has no "${name}" mark type`);
  }
  return type;
}

/** The `reference` node type — exported for composer.tsx, which needs it to build a live Reference node from the `[[` picker and from `insertAtCursor`. */
export const referenceNodeType = requireNodeType("reference");

// ---------------------------------------------------------------------------
// Mark input rules: **bold**, *italic*, `code`
// ---------------------------------------------------------------------------

/**
 * Applies `markType` to whatever `regexp`'s first capture group matched,
 * deleting the delimiter characters around it — `**bold**` becomes `bold`
 * with the strong mark applied, never left as literal asterisks next to
 * formatted text.
 *
 * The delimiters can sit on either side of the captured text asymmetrically
 * in principle (a future rule might not be `X...X`), so this locates the
 * capture by its actual offset within the full match (`match[0].indexOf`)
 * rather than assuming it starts right after a fixed-length opener; deletes
 * whatever trails the capture first (positions past it are unaffected by
 * that deletion), then whatever leads it, so the final `addMark` range
 * always lines up with where the captured text now actually sits.
 *
 * `removeStoredMark` after applying is what stops the NEXT character typed
 * from inheriting the mark — without it, typing were to continue directly
 * after `**bold**` would carry on as bold, which is not what closing a pair
 * of delimiters means.
 */
function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const captured = match[1];
    if (captured === undefined || captured.trim() === "") {
      return null;
    }
    const offset = match[0].indexOf(captured);
    if (offset < 0) {
      return null;
    }
    const tr = state.tr;
    const textStart = start + offset;
    const textEnd = textStart + captured.length;
    if (textEnd < end) {
      tr.delete(textEnd, end);
    }
    if (textStart > start) {
      tr.delete(start, textStart);
    }
    const markEnd = start + captured.length;
    tr.addMark(start, markEnd, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

/**
 * `(?<!\*)` guards the em rule's opening `*` — without it, typing
 * `**bold**` one character at a time misfires: input rules re-run on
 * EVERY keystroke, not just the final one, and the instant the FIRST
 * closing `*` of the pair is typed, the text in front of the caret is
 * `**bold*` — which `\*([^*]+)\*$` alone genuinely matches, at the
 * SECOND `*` as its opener and the just-typed one as its closer, turning
 * "bold" italic and leaving one stray `*` behind before the strong rule
 * ever gets a chance to see two adjacent closers. Verified live in a real
 * browser (jsdom cannot drive `handleTextInput` at all — composer.tsx's
 * own module comment), not reasoned out ahead of time; a naive read of
 * the finished string "**bold**" makes the two patterns look
 * structurally exclusive, and they are NOT once every intermediate
 * keystroke is considered. The lookbehind closes exactly that gap:
 * an opening `*` immediately preceded by another `*` is never a valid
 * em delimiter, so the false match above no longer exists, and the
 * legitimate case (an em delimiter preceded by anything else, or
 * nothing at all) is untouched.
 */
const strongInputRule = markInputRule(/\*\*([^*]+)\*\*$/, requireMarkType("strong"));
const emInputRule = markInputRule(/(?<!\*)\*([^*]+)\*$/, requireMarkType("em"));
const codeInputRule = markInputRule(/`([^`]+)`$/, requireMarkType("code"));

/**
 * The underscore spellings of the same two marks, which exist for one
 * reason: the READER already understands them.
 *
 * `parseEntryMarkdown` is CommonMark, so `_x_` is emphasis and `__x__` is
 * strong whether or not the Composer has ever heard of them. Without these
 * rules the two halves disagreed in the one way this whole change exists to
 * prevent — a body typed as `remember _this_` showed literal underscores the
 * entire time it was being written, then rendered italic the instant it was
 * Sent. `escapeUserText` does not escape `_` either, so nothing downstream
 * caught it.
 *
 * `(?<![\w_])` is the intraword guard, and it is not optional. CommonMark
 * deliberately refuses `_` emphasis inside a word — that is what keeps
 * `snake_case_var` intact — and a rule without the lookbehind would fire on
 * the `_case_` in the middle of one, italicising a variable name as it is
 * typed. Matching CommonMark's full left/right-flanking rules in a regex is
 * not practical; requiring the opening `_` to follow a non-word character
 * (or nothing) covers the cases a person actually types and errs toward
 * leaving text alone. `__strong__` is listed first for the same
 * keystroke-ordering reason the `*` pair needs its own lookbehind.
 */
const strongUnderscoreInputRule = markInputRule(
  /(?<![\w_])__([^_]+)__$/,
  requireMarkType("strong"),
);
const emUnderscoreInputRule = markInputRule(/(?<![\w_])_([^_]+)_$/, requireMarkType("em"));

// ---------------------------------------------------------------------------
// List input rules: "- "/"+ "/"* ", "1. "/"1) ", and "- [ ] "/"- [x] " for a
// checkbox (issue #161 widens the first two to match every spelling
// `parseEntryMarkdown` already accepts, and adds the one-step checklist
// trigger further down)
// ---------------------------------------------------------------------------

/**
 * Every regexp below that matches trailing whitespace with `\s` already
 * tolerates U+00A0 (a non-breaking space) — `\s` in a JavaScript RegExp is
 * defined over the Unicode `White_Space` property, which NBSP is part of,
 * not over the literal ASCII space alone. That matters here specifically
 * because index.css's own `.ProseMirror` rule only just started setting
 * `white-space: pre-wrap`/`break-spaces` (issue #158, same ticket as this
 * comment); without it, a browser is free to normalise a typed space into
 * U+00A0 so it survives `white-space: normal` collapsing (ProseMirror
 * upstream issues #981 and #598), and WebKit does this far more eagerly
 * than Chromium — a rule that looks green in Chromium can be silently
 * dead in WKWebView. Only `checkboxInputRule`'s pattern below matches a
 * literal space with `[ xX]` — a character class, not `\s` — which is why
 * it is the one rule that actually needed changing.
 */
const bulletListNodeType = requireNodeType("bullet_list");
const orderedListNodeType = requireNodeType("ordered_list");
const listItemNodeType = requireNodeType("list_item");

/**
 * `[-+*]`: CommonMark's own bullet-marker alphabet is exactly these three
 * characters (see `entryParser`'s use of the stock `@lezer/markdown` bullet
 * parser, inline-markdown.ts), so `parseEntryMarkdown` already turns
 * `* milk` into a bullet list on Send — it always has. Until issue #161
 * this rule only matched `-`/`+`, so typing `*` left a literal asterisk on
 * screen the entire time it was being written, then a bullet the instant it
 * was Sent: the two parse entry points ADR 0043 claims share "one dialect"
 * actually disagreed about a real, common way to start a bullet. `* ` is
 * also EXACTLY what `escapeUserText` (entry-document.ts) has always escaped
 * a leading `*` to `\*` for — that escape was written for prose that merely
 * starts with an asterisk, but it was silently carrying the entire weight
 * of covering for this rule's own gap, since a `* milk` typed into the
 * Composer had nowhere else to go. Verified on a real macOS build, not
 * inferred from reading the grammar: typing `* milk` before this change
 * left `* milk` on screen and only became a bullet after Send. ADR 0045
 * has the full account.
 */
const bulletListInputRule = wrappingInputRule(/^\s*([-+*])\s$/, bulletListNodeType);

/**
 * `[.)]`: CommonMark's ordered-list marker is a run of digits followed by
 * EITHER `.` or `)` — `orderedListStart` (inline-markdown.ts) reads the
 * digits off whichever delimiter shows up, its own comment says so
 * explicitly ("`1.` and `1)` both give 1") — so `1) alpha` has always
 * become an ordered list on Send. Until issue #161 this rule only matched
 * `.`, the same one-sided gap `bulletListInputRule` had for `*`: typing
 * `1) alpha` left the literal text `1) alpha` on screen for as long as it
 * was being edited, then reflowed into a numbered item the instant it was
 * Sent. Verified on a real macOS build the same way the `*` case was.
 */
const orderedListInputRule = wrappingInputRule(
  /^(\d+)[.)]\s$/,
  orderedListNodeType,
  (match) => ({ order: Number(match[1]) }),
  // Standard prosemirror-schema-list join predicate (its own module
  // comment recommends exactly this): continuing a `5. `, `6. `, ... run
  // directly after an existing ordered list joins into it rather than
  // starting a second, adjacent one — matched here against the SAME
  // numbering `entryDocumentToMarkdown`'s own `markerFor` would have
  // produced for that position, so a list typed this way round-trips
  // identically to one written by hand. The delimiter itself (`.` vs `)`)
  // plays no part in this predicate — `markerFor` only ever writes `N. `
  // regardless of which one was typed (emission does not change, ADR
  // 0045), so a `1) `/`2) `/`3) ` run joins exactly as a `1. `/`2. `/`3. `
  // one already did.
  (match, node) => node.childCount + Number(node.attrs.order) === Number(match[1]),
);

/**
 * `- [ ] ` / `- [x] `: not one rule, but the composition of two — the
 * bullet rule above already turns `- ` into a plain bullet item the instant
 * the space after the dash is typed, before `[ ] ` even exists to match
 * against. This rule is what upgrades that already-created item into a
 * task a few keystrokes later: it fires only when `[ ]`/`[x]` plus a space
 * is typed at the very START of a list item's own opening paragraph (never
 * mid-item — a checkbox typed into a later paragraph inside a multi-block
 * item would be describing that paragraph's content, not the item's own
 * state), and sets `checked` on the enclosing `list_item` rather than on
 * the paragraph the regexp actually matched against.
 *
 * A plain paragraph (no enclosing list item, or not that item's first
 * child) returns `null` — the typed `[ ] ` stays exactly as typed, a
 * checkbox mark meaning nothing outside a list is not part of this
 * dialect's grammar any more than a heading is (ADR 0043).
 */

/**
 * The unchecked marker's space, in `checkboxInputRulePattern` below, is
 * matched as a literal character class rather than `\s` — unlike every
 * other whitespace-matching rule in this file (see the comment above
 * `bulletListNodeType`), so it does not inherit `\s`'s built-in NBSP
 * tolerance for free. A browser is free to normalise a typed space into
 * U+00A0 (non-breaking) once it decides ordinary spaces might get
 * collapsed away (ProseMirror upstream issues #981 and #598) — WebKit
 * does this far more eagerly than Chromium — so `[ xX]` with only U+0020
 * inside it made `- [ ] ` silently fail to become a checkbox in exactly
 * the browsers most likely to have already substituted the space by the
 * time this rule ever sees it. The class below adds `\u00A0` alongside
 * the ordinary space so it accepts either character an "unchecked" box
 * can arrive as; `xX` is unaffected since a letter is never normalised
 * this way. Exported so a unit test (jsdom cannot mount a live
 * `EditorView` — ADR 0044) can feed a real U+00A0 through the pattern
 * directly rather than only through a live keystroke no test harness here
 * can send.
 */
export const checkboxInputRulePattern = /^\[([ \u00A0xX])\]\s$/;

function checkboxInputRule(): InputRule {
  return new InputRule(checkboxInputRulePattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const grandParent = $start.node(-1);
    if (grandParent.type !== listItemNodeType) {
      return null;
    }
    if ($start.index(-1) !== 0) {
      return null;
    }
    const marker = match[1];
    const checked = marker !== undefined && marker.toLowerCase() === "x";
    const itemPos = $start.before(-1);
    return state.tr.delete(start, end).setNodeMarkup(itemPos, undefined, { checked });
  });
}

/**
 * `[] `/`[x] `/`[X] ` at the very start of an ordinary paragraph: a
 * one-step checklist trigger (issue #161), distinct from the two-step
 * `- ` then `[ ] ` dance `checkboxInputRule` above upgrades. UpNote ships
 * exactly this trigger (verified in its shipped bundle) and it is a real
 * improvement in feel — a checklist is one keystroke pattern to reach for,
 * not two, and the two-step path a person already knows (`- [ ] `, muscle
 * memory or pasted GFM) keeps working unchanged alongside it.
 *
 * This is NOT `parseEntryMarkdown` symmetry the way `bulletListInputRule`'s
 * new `*` and `orderedListInputRule`'s new `1)` are: the reader never
 * treats a bare `[] ` outside a list item as a checkbox — GFM's own
 * `TaskList` extension only fires inside a `ListItem` (inline-markdown.ts's
 * own comment on `entryParser` says so), so there is no reader-side marker
 * this rule is catching up to. It is a Composer-only convenience that
 * produces exactly the structure `- [ ] `/`- [x] ` already produces —
 * `bullet_list` > `list_item` with `checked` set — so nothing downstream
 * (the serializer, the reader, the round-trip fixpoint) can tell the two
 * paths apart once the keystrokes are done. `entryDocumentToMarkdown` still
 * only ever emits `- [ ] `/`- [x] ` for it either way (ADR 0045): a
 * one-step trigger on the way in does not mean a new spelling on the way
 * out.
 *
 * The empty-brackets spelling is deliberately `[xX]?` here rather than
 * reusing `checkboxInputRulePattern`'s `[  xX]` (which requires
 * exactly one character between the brackets): `checkboxInputRulePattern`
 * is upgrading an ALREADY-GFM `[ ]`/`[x]` a person typed or pasted, where a
 * space between the brackets is mandatory grammar, so a bare `[]` there
 * would be malformed input rather than the trigger this rule exists for.
 * UpNote's trigger is the opposite shape on purpose — nothing between the
 * brackets means unchecked, `x`/`X` means checked — mirroring how a person
 * actually types a fresh checklist rather than how GFM spells a finished
 * one. Only the checked spelling can carry an NBSP (a browser substituting
 * the space before `x`/`X` cannot happen — there is no space there to
 * substitute), so nbsp tolerance here rides entirely on the trailing `\s`
 * before the cursor, the same free tolerance every other rule in this file
 * gets from `\s` (see the comment above `bulletListNodeType`).
 *
 * Exported for the same reason `checkboxInputRulePattern` is: jsdom cannot
 * mount a live `EditorView` (ADR 0044), so a unit test exercises this
 * pattern (and `checklistShortcutInputRule`'s handler) directly rather than
 * through a live keystroke, which belongs in apps/e2e's composer.spec.ts.
 */
export const checklistShortcutInputRulePattern = /^\[([xX]?)\]\s$/;

/**
 * The handler side of `checklistShortcutInputRulePattern` above. Unlike
 * `bulletListInputRule`/`orderedListInputRule`, this cannot be built with
 * `wrappingInputRule` alone: that helper's `getAttrs` only ever applies to
 * the OUTERMOST node it wraps in (`bullet_list` here), never to the
 * `list_item` `findWrapping` inserts underneath it to satisfy
 * `bullet_list`'s own `"list_item+"` content expression (confirmed against
 * `prosemirror-transform`'s own `findWrapping`/`withAttrs`, which hard-codes
 * `attrs: null` for every wrapper besides the one actually asked for) — and
 * `checked` is exactly the attribute that lives on that inner `list_item`,
 * not on the `bullet_list` around it. So this rule does by hand what
 * `wrappingInputRule` does internally (delete the matched marker, wrap the
 * now-bare paragraph, look at what came out) and then takes the one extra
 * step `wrappingInputRule` has no hook for: setting `checked` on the
 * `list_item` `findWrapping` just created, the same way `checkboxInputRule`
 * above sets it on an EXISTING one.
 *
 * The guard against an already-listed paragraph is deliberate and mirrors
 * `checkboxInputRule`'s own "must already be inside a list item" check,
 * inverted: this rule only wraps a paragraph that is NOT already a list
 * item's child. `entrySchema` only ever nests a paragraph directly under
 * `doc` or under `list_item` (there is no blockquote, no other container —
 * entry-schema.ts's own module comment explains why), so "not a list
 * item's child" and "a genuinely plain, top-level-or-nested-prose
 * paragraph" are the same test. Without it, typing `- ` to open a bullet
 * (leaving an empty `list_item > paragraph`) and then typing `[x] ` inside
 * it would double-wrap that already-live item in a SECOND `bullet_list`
 * nested inside the first, instead of falling through to
 * `checkboxInputRule` — which is exactly the rule that already knows how
 * to upgrade an existing item in place, and must keep being the one that
 * does it.
 *
 * No attempt is made here to join a freshly-wrapped `bullet_list` into an
 * ADJACENT one the way `wrappingInputRule`'s own built-in join (used by
 * `bulletListInputRule`/`orderedListInputRule` above) would. That join
 * exists for continuing a list a person is actively typing into — Enter
 * inside a list item already keeps the whole item lineage in ONE
 * `bullet_list` via `splitListItem` (`listKeymap` below) long before this
 * rule ever runs again, so the case the join would cover — this exact
 * rule firing twice back-to-back against two freshly-typed top-level
 * paragraphs, with no Enter-inside-a-list-item in between — is not how a
 * checklist actually gets built one item at a time, and is not part of
 * this ticket's acceptance bar.
 */
function checklistShortcutInputRule(): InputRule {
  return new InputRule(checklistShortcutInputRulePattern, (state, match, start, end) => {
    const $before = state.doc.resolve(start);
    if ($before.node(-1).type === listItemNodeType) {
      return null;
    }
    const tr = state.tr.delete(start, end);
    const range = tr.doc.resolve(start).blockRange();
    if (range === null) {
      return null;
    }
    const wrapping = findWrapping(range, bulletListNodeType);
    if (wrapping === null) {
      return null;
    }
    tr.wrap(range, wrapping);
    const $wrapped = tr.doc.resolve(tr.mapping.map(start));
    if ($wrapped.node(-1).type !== listItemNodeType) {
      return null;
    }
    const marker = match[1];
    const checked = marker !== undefined && marker.toLowerCase() === "x";
    const itemPos = $wrapped.before(-1);
    return tr.setNodeMarkup(itemPos, undefined, { checked });
  });
}

// ---------------------------------------------------------------------------
// Reference input rule: "[[YYYY-MM-DD]]"/"[[e:<uuid>]]" typed by hand
// ---------------------------------------------------------------------------

/**
 * Converts a hand-typed `[[…]]` into a live `reference` node the instant its
 * closing `]]` completes it, rather than requiring the `[[` picker's
 * dropdown — before this rule, typing a Reference by hand left it as inert
 * paragraph text, which `entry-document.ts`'s `escapeUserText` then escaped
 * to `\[[…]]` on Send, so it could never become a chip.
 *
 * `inner`'s well-formedness is checked through `parseReferenceDate`/
 * `parseReferenceEntryId` (inline-markdown.ts) — the SAME functions
 * `referenceParser` uses to decide whether the reader's own parse path
 * recognises a mark — rather than a second regex here that could drift
 * from it (ADR 0044's one-grammar property). `[[not a date]]`,
 * `[[2026-13-45]]` and `[[e:notauuid]]` all fail both checks and return
 * `null`, which leaves the typed characters as an ordinary paragraph run:
 * exactly the text `escapeUserText` still needs to escape for the
 * round-trip fixpoint to hold.
 */
const referenceInputRule = new InputRule(/\[\[([^[\]]*)\]\]$/, (state, match, start, end) => {
  const inner = match[1];
  if (inner === undefined) {
    return null;
  }
  const date = parseReferenceDate(inner);
  const entryId = date === null ? parseReferenceEntryId(inner) : null;
  if (date === null && entryId === null) {
    return null;
  }
  const attrs: ReferenceAttrs =
    date !== null
      ? { kind: "date", raw: match[0], date, entryId: null }
      : { kind: "entry", raw: match[0], date: null, entryId };
  return state.tr.replaceRangeWith(start, end, referenceNodeType.create(attrs));
});

export function buildInputRules(): InputRule[] {
  return [
    strongInputRule,
    strongUnderscoreInputRule,
    emInputRule,
    emUnderscoreInputRule,
    codeInputRule,
    bulletListInputRule,
    orderedListInputRule,
    checkboxInputRule(),
    checklistShortcutInputRule(),
    referenceInputRule,
  ];
}

// ---------------------------------------------------------------------------
// Keymap: splitListItem / outdent on Enter, undo/redo, everything else from
// prosemirror-commands' baseKeymap
// ---------------------------------------------------------------------------

/**
 * `chainCommands(splitListItem, outdent.run)` is the shape
 * prosemirror-schema-list's own `splitListItem` doc comment is written
 * for: on a non-empty list item it splits into the next item; on an EMPTY
 * top-level item it deliberately returns `false` ("bail out and let next
 * command handle lifting") rather than lifting itself, which is exactly
 * what makes chaining `outdent.run` right after it correct instead of
 * redundant — Enter on an empty item then escapes the list one level, per
 * the ticket. Outside a list entirely both commands return `false` and the
 * key falls through (see this module's own comment on plugin order in
 * `buildComposerPlugins`) to `baseKeymap`'s own Enter, an ordinary
 * paragraph split.
 *
 * `outdent` (issue #160, composer-commands.ts) is `liftListItem(listItemNodeType)`
 * itself, given a name and reused here rather than called a second time —
 * one command, two callers (this binding and, eventually, a keyboard
 * shortcut or a toolbar button), never two independent constructions of
 * `liftListItem` that could quietly diverge if one were ever edited without
 * the other.
 *
 * `Shift-Enter` is bound to the SAME chain, plus `splitBlock` appended as
 * its own final fallback — not left to fall through to `baseKeymap` the
 * way plain `Enter` does. `prosemirror-keymap`'s own matching (verified by
 * reading its source, not assumed) only tries a held Shift as a fallback
 * for single-character keys — "a", producing "A" — never for a NAMED key
 * like "Enter", so a keymap that binds only `Enter` is never consulted at
 * all for `Shift-Enter`; the keydown handler returns `false` outright,
 * nothing calls `preventDefault()`, and the browser's own native
 * contenteditable behaviour runs unopposed — normally a bare `<br>`,
 * which `entrySchema` has no node for at all (there is no `hard_break`),
 * so ProseMirror's own DOMObserver reconciles the DOM straight back to
 * the document's real state on its very next update and the keystroke
 * simply vanishes. The ticket's own requirement is only "Shift+Enter
 * still never sends" — true either way, since `isSubmitChord` already
 * excludes it — but silently eating the keystroke is worse than making it
 * behave exactly like a plain Enter, which is what the pre-#155
 * `<textarea>` did for both (issue #76: neither one ever sent, and both
 * inserted the same plain newline).
 */
/**
 * Backspace lifts a list item out one level, but ONLY at the very start of
 * the item's FIRST paragraph — issue #162. Unlike Tab/Ctrl-]'s indent
 * below, this cannot simply bind straight to `outdent.run`
 * (`liftListItem(listItemNodeType)`, composer-commands.ts): that command's
 * own applicability check is only "is the caret inside a list item
 * somewhere," true for every position in a multi-paragraph item, not just
 * its edge. Backspace deleting a character mid-paragraph, or joining a
 * second paragraph back into an item's first one, must keep behaving
 * exactly as `baseKeymap` already makes it behave — only the one boundary
 * case (caret at offset 0 of the item's opening paragraph) is this
 * ticket's "lift it out" gesture, matching what every editor in this space
 * (Notion, Obsidian, UpNote) does with Backspace there.
 *
 * `entrySchema`'s `list_item` content is `"paragraph block*"`
 * (entry-schema.ts) — a required leading `paragraph`, then any number of
 * further blocks (a nested `bullet_list`/`ordered_list`, or in principle a
 * second `paragraph`). That leading paragraph is always `list_item`'s
 * direct child (never itself wrapped in something else), so "the very
 * start of the item's first paragraph" is exactly: an empty selection,
 * `$from.parentOffset === 0` (nothing before the caret in its immediate
 * textblock), the node one depth up is a `list_item`, and the caret's
 * textblock is that `list_item`'s child index 0 — index 0 rather than any
 * later paragraph is what makes this "first paragraph" rather than
 * "any paragraph," so Backspace at the start of a SECOND paragraph inside
 * one item still falls through to `baseKeymap`'s `joinBackward`, joining
 * it into the first paragraph, exactly as today.
 *
 * Registered as its own `Backspace` binding in THIS plugin rather than
 * built with `chainCommands` alongside `baseKeymap`'s
 * `deleteSelection, joinBackward, selectNodeBackward` — like `Enter`
 * above, "chained before" those three is accomplished by plugin order
 * (`buildComposerPlugins`'s own comment): this plugin runs first, and
 * returning `false` here (selection non-empty, caret mid-item, or no list
 * at all) lets `keymap(baseKeymap)`'s own `Backspace` run unopposed,
 * exactly the same fallthrough `listChain`'s `Enter` binding relies on.
 *
 * Exported (unlike `listKeymap`/`historyKeymap` themselves) so
 * composer-editor.test.ts can exercise its gating directly against a plain
 * `EditorState` — the same "no `EditorView`" constraint ADR 0044 and this
 * file's own module comment already document, and the same reason
 * composer-commands.ts exports `indent`/`outdent` rather than keeping
 * `sinkListItem`/`liftListItem` private to a keymap closure.
 */
export const liftAtStartOfListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) {
    return false;
  }
  const itemDepth = $from.depth - 1;
  if (itemDepth < 0 || $from.node(itemDepth).type !== listItemNodeType) {
    return false;
  }
  if ($from.index(itemDepth) !== 0) {
    return false;
  }
  return outdent.run(state, dispatch);
};

/**
 * Tab/Shift-Tab indent/outdent a list item (`indent`/`outdent`, issue
 * #160's registry — composer-commands.ts, themselves
 * `sinkListItem(listItemNodeType)`/`liftListItem(listItemNodeType)`) — but
 * ONLY when the caret is inside a list item. That gating needs no extra
 * code here: `sinkListItem`/`liftListItem` already return `false` outside
 * one (both walk the selection's own ancestors the same way this module's
 * `nearestListItem`, composer-commands.ts, does, and find nothing to
 * sink/lift), which — same fallthrough mechanism as `Enter`/`Backspace`
 * above — means `false` here reaches `prosemirror-keymap`'s handler,
 * `preventDefault()` is never called, and the browser's own native Tab
 * (move focus to the next focusable element) runs unopposed. This is the
 * one binding in this file where "does nothing" is load-bearing rather
 * than incidental: a Composer that swallowed Tab unconditionally would be
 * a keyboard trap (WCAG 2.1.2), unable to hand focus back to the rest of
 * the page at all from inside a list. See composer.spec.ts's own
 * "Tab outside a list still moves focus" e2e case, which exists
 * specifically to catch a regression here.
 *
 * `Ctrl-]`/`Ctrl-[` are unconditional aliases for the same two commands —
 * deliberately bound to literal `Ctrl-`, NOT `Mod-` (which
 * `prosemirror-keymap` resolves to `Cmd-` on macOS, `Ctrl-` elsewhere).
 * `Cmd-]` is already browser-forward navigation on macOS Safari/Chrome, so
 * `Mod-]` here would either lose to the browser or silently hijack a
 * shortcut people already have muscle memory for outside this app. Todoist
 * ships indent as `Control+]`/`Control+[` on EVERY platform, macOS
 * included, for exactly this reason — one chord, not a per-platform pair,
 * at the documented cost (their own docs) that it has no dedicated key on
 * keyboard layouts without bracket keys. That tradeoff is accepted here
 * deliberately, not an oversight: it is the same chord Tab/Shift-Tab
 * already cover for anyone on a layout where it doesn't work.
 */
function listKeymap(): Plugin {
  const listChain = chainCommands(splitListItem(listItemNodeType), outdent.run);
  return keymap({
    Enter: listChain,
    "Shift-Enter": chainCommands(listChain, splitBlock),
    Backspace: liftAtStartOfListItem,
    Tab: indent.run,
    "Shift-Tab": outdent.run,
    "Ctrl-]": indent.run,
    "Ctrl-[": outdent.run,
  });
}

/**
 * `undoCommand.run`/`redoCommand.run` (issue #160, composer-commands.ts) ARE
 * `undo`/`redo` from `prosemirror-history` — the registry wraps them rather
 * than replacing them, so binding these chords through the registry instead
 * of importing `undo`/`redo` here directly changes nothing about what runs,
 * only where the name "this is the undo command" is defined.
 */
function historyKeymap(): Plugin {
  return keymap({
    "Mod-z": undoCommand.run,
    "Shift-Mod-z": redoCommand.run,
    "Mod-y": redoCommand.run,
  });
}

/**
 * Issue #164's four chords — the toolbar's own eleven buttons (#164,
 * composer-toolbar.tsx) are how every one of `composerCommands` is reached
 * without a keyboard, but four of them are common enough, and old enough as
 * conventions (every rich-text surface a reader has ever used binds
 * Cmd/Ctrl-B/I), that they also get a direct chord: `bold.run`/`italic.run`/
 * `code.run` (composer-commands.ts) are wired here exactly as `undo`/`redo`
 * are just above — the registry owns what each action IS, this file only
 * owns which keystroke reaches it. `Mod-Shift-Enter` is the fourth, bound to
 * `toggleCheckboxDone.run` (composer-commands.ts) rather than a button:
 * see that command's own doc comment for why it gets a chord and no button.
 *
 * `Mod-Shift-Enter` is safe to claim specifically because `isSubmitChord`
 * (submit-chord.ts) already returns `false` whenever `event.shiftKey` is
 * set — Shift+Enter, with or without Cmd/Ctrl, was never going to reach
 * Send, so this chord is free to mean something else without shadowing the
 * one Composer chord that must never move.
 *
 * Lists (`bulletList`/`orderedList`/`checklist`) deliberately get NO chord
 * here, even though they're in the same registry: each already has three
 * paths in place or on the way — a typed marker (composer-editor.ts's own
 * input rules, above), the toolbar button, and the `/` menu #165 adds — and
 * Todoist ships exactly this (typed marker + button + slash command, no
 * dedicated list chord) for the same reason: a fourth path buys nothing a
 * reader doesn't already have. Indent/outdent keep the Tab/Shift-Tab/
 * Ctrl-]/Ctrl-[ bindings `listKeymap` above already gives them (issue #162)
 * unchanged — they are not repeated or aliased here. The toolbar's own
 * on/off toggle (composer-toolbar.tsx / composer.tsx) gets no chord either;
 * it is flipped once, in Settings-adjacent reach, not a per-Entry action.
 *
 * A short list of chords this app can NEVER claim, recorded here because
 * the next person adding a binding will not have just rediscovered them the
 * way this ticket did:
 *
 * - `Mod-1` through `Mod-9` — every Chromium- and WebKit-based browser
 *   reserves these for switching tabs by position; a page cannot intercept
 *   them at all.
 * - `Mod-l` — every mainstream browser's own "focus the address bar."
 * - `Mod-[` / `Mod-]` — back/forward navigation, at least on macOS
 *   Safari/Chrome (`listKeymap`'s own comment above records this in more
 *   detail; it's why #162's indent/outdent use literal `Ctrl-`, never
 *   `Mod-`, for exactly this pair). Whether every OTHER platform also
 *   reserves them was not re-verified here — `Ctrl-` was already the
 *   established answer and this ticket had no reason to relitigate it.
 * - `Mod-t`/`Mod-w`/`Mod-n`/`Mod-r`/`Mod-d` — new tab, close tab, new
 *   window, reload, bookmark. Never verified case-by-case against every
 *   browser this app ships on; treated as permanently off-limits rather
 *   than probed, on the same reasoning `isSubmitChord`'s own module comment
 *   gives for erring toward the failure mode that gets noticed (a chord
 *   that silently does nothing here) over the one that doesn't (a chord
 *   that fights the browser chrome around this app).
 */
function formatKeymap(): Plugin {
  return keymap({
    "Mod-b": bold.run,
    "Mod-i": italic.run,
    "Mod-e": code.run,
    "Mod-Shift-Enter": toggleCheckboxDone.run,
  });
}

// ---------------------------------------------------------------------------
// The inline `[[` picker's ProseMirror-side trigger detection
// ---------------------------------------------------------------------------

export const pickerPluginKey = new PluginKey<ReferencePickerState | null>("composer-picker");

/**
 * The meta flag composer.tsx's own Escape handler sets on an otherwise
 * empty transaction (no doc change, no selection change) to force the
 * picker closed without touching the document. Necessary because — unlike
 * the old `<textarea>`, where `setPicker(null)` was a plain, independent
 * piece of React state — this plugin's state is DERIVED fresh from the doc
 * and selection on every transaction (see `pickerPlugin`'s own comment);
 * dispatching a transaction that carries neither would otherwise re-derive
 * the exact same open state right back, since nothing about the text or
 * caret actually changed. `dispatchTransaction` never marks the Entry
 * dirty for a transaction like this one (it checks `docChanged`, and a
 * dismiss carries none), which matters: pressing Escape to close the list
 * must never be what makes closing an unedited Entry look "changed".
 */
export const PICKER_DISMISS_META = "dismiss";

/**
 * One textblock's own content, flattened to plain text with each inline
 * atom (a `reference` node) standing in for exactly one character —
 * `￼`, the Unicode object-replacement character ProseMirror's own
 * `textBetween` already uses as its conventional leaf placeholder. That
 * choice is what keeps a doc position (where an atom's `nodeSize` is 1,
 * same as any single character) and an index into this string in exact 1:1
 * correspondence, which is the property `derivePicker`'s caller relies on
 * below: `$from.parentOffset` can be used directly as an index into this
 * string, and a string index this function returns can be added straight
 * back onto the block's own start position with no further conversion.
 */
function textBlockPlainText(parent: PMNode): string {
  let out = "";
  parent.forEach((child) => {
    out += child.isText ? (child.text ?? "") : "￼";
  });
  return out;
}

/**
 * Recomputes the picker's state from scratch on every transaction — same
 * rule composer-picker.ts's own module comment gives for `derivePicker`
 * itself, extended one layer out: rather than track "did the doc change
 * near the trigger" incrementally, this rebuilds the current textblock's
 * plain text and caret position fresh every time and re-derives from that,
 * so a keystroke, a backspace, and the caret simply moving away are all the
 * same code path here too.
 *
 * `previous.start`/the derived result's `start` are absolute document
 * positions; `derivePicker` itself only ever deals in offsets relative to
 * the CURRENT textblock, so this plugin is the translation layer between
 * the two — see `textBlockPlainText`'s own comment for why that
 * translation is exact arithmetic rather than an approximation. If the
 * selection has moved to a different textblock since `previous` was set,
 * the translated `relativeStart` will not describe a real trigger position
 * in the new block's text; `derivePicker`'s own validation (re-checking
 * that its two preceding characters are still the trigger) rejects that
 * cleanly and returns `null` rather than needing this plugin to detect the
 * block change itself.
 */
export function pickerPlugin(): Plugin<ReferencePickerState | null> {
  return new Plugin<ReferencePickerState | null>({
    key: pickerPluginKey,
    state: {
      init: (): ReferencePickerState | null => null,
      apply(tr, previous, _oldState, newState): ReferencePickerState | null {
        if (tr.getMeta(pickerPluginKey) === PICKER_DISMISS_META) {
          return null;
        }
        const { $from } = newState.selection;
        if (!$from.parent.isTextblock) {
          return null;
        }
        const blockStart = $from.start();
        const text = textBlockPlainText($from.parent);
        const caret = $from.parentOffset;
        const relativePrevious =
          previous === null ? null : { start: previous.start - blockStart, query: previous.query };
        const next = derivePicker(text, caret, relativePrevious);
        return next === null ? null : { start: next.start + blockStart, query: next.query };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// The `/` menu's ProseMirror-side trigger detection (issue #165)
// ---------------------------------------------------------------------------

export const slashPluginKey = new PluginKey<SlashMenuState | null>("composer-slash");

/**
 * Same role as `PICKER_DISMISS_META` above, for the `/` menu — composer.tsx's
 * Escape handler and its own "zero matches" effect both need to force this
 * plugin's derived state closed without an accompanying document change,
 * for the identical reason `pickerPluginKey`'s own comment already gives:
 * this plugin's state is recomputed fresh from the doc and selection on
 * every transaction, so a transaction carrying neither would otherwise just
 * re-derive the same open state right back.
 */
export const SLASH_DISMISS_META = "dismiss";

/**
 * Recomputes the `/` menu's state from scratch on every transaction —
 * `pickerPlugin`'s own shape immediately above, reused for the reasons
 * that function's comment already gives, with one addition: the Reference
 * picker always wins. `slashPlugin` MUST be registered after `pickerPlugin()`
 * in `buildComposerPlugins` below, specifically so that
 * `pickerPluginKey.getState(newState)` here reads that plugin's OWN
 * freshly-computed state for THIS transaction, not last transaction's —
 * `EditorState.apply` computes each plugin's state field in registration
 * order, threading the in-progress `newState` through every later field's
 * own `apply` call, so a plugin registered later can depend on one
 * registered earlier within the very same transaction. Without this check,
 * typing `/[[` — a `/` immediately followed by a hand-typed Reference
 * trigger — would open both menus on the same keystroke: the ticket's own
 * "both menus must never be open at once, and typing `[[` must still open
 * the Reference picker" requirement, enforced here at the SOURCE rather
 * than by composer.tsx picking one of two open menus to render. Forcing it
 * closed here means every other reader of `slashPluginKey`'s state
 * (composer.tsx's keydown handling, its own listbox) can trust "non-null"
 * to mean "safe to show," with no second check needed anywhere else.
 */
export function slashPlugin(): Plugin<SlashMenuState | null> {
  return new Plugin<SlashMenuState | null>({
    key: slashPluginKey,
    state: {
      init: (): SlashMenuState | null => null,
      apply(tr, previous, _oldState, newState): SlashMenuState | null {
        if (tr.getMeta(slashPluginKey) === SLASH_DISMISS_META) {
          return null;
        }
        if (pickerPluginKey.getState(newState) !== null) {
          return null;
        }
        const { $from } = newState.selection;
        if (!$from.parent.isTextblock) {
          return null;
        }
        const blockStart = $from.start();
        const text = textBlockPlainText($from.parent);
        const caret = $from.parentOffset;
        const relativePrevious =
          previous === null ? null : { start: previous.start - blockStart, query: previous.query };
        const next = deriveSlashMenu(text, caret, relativePrevious);
        return next === null ? null : { start: next.start + blockStart, query: next.query };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Checklist line highlighting and click-to-demote (issue #173)
// ---------------------------------------------------------------------------

/**
 * Every option `parseQuickAdd` needs (`@meologue/core`), read fresh on
 * every call rather than threaded in as a plugin parameter — cheap, and
 * the same "recomputed on every render" posture add-task-form.tsx's own
 * identical `options` literal already takes for the add field
 * (`localDayKey(new Date())`/`smartDatesEnabled`), for the same reason: a
 * ProseMirror plugin is built exactly once per Composer instance
 * (`buildComposerPlugins`, composer.tsx's own `useState` initializer), so
 * caching this at construction time would leave it stale the moment the
 * Device crosses midnight or the reader flips Smart dates in Settings
 * while the Composer stays mounted. `entryDayKey`/`deviceUtcOffsetMinutes`
 * rather than `date-picker-sheet.tsx`'s own `localDayKey` — the two
 * compute the identical device-local `YYYY-MM-DD`, but this file already
 * sits under `lib/`, and reaching into a `components/` file for a date
 * utility would be the one import in it running the wrong direction.
 *
 * Exported so `use-history.ts`'s `sendEntry`/`commitEntryEdit` can fall
 * back to this SAME computation when no live Composer handed over its own
 * `QuickAddOptions` (promote-tasks.ts's own header comment, "keeping the
 * parse in step with the highlight") — one function computing "now" for
 * quick-add purposes, not two that could drift apart.
 */
export function quickAddOptionsNow(): { now: string; smartDates: boolean } {
  return {
    now: entryDayKey(new Date().toISOString(), deviceUtcOffsetMinutes()) ?? "",
    smartDates: useSettingsStore.getState().smartDatesEnabled,
  };
}

/**
 * The one checklist line currently being typed into, if any — `blockStart`
 * is the paragraph's own content start (the same absolute doc position
 * `pickerPlugin`'s `$from.start()` already uses, so `textBlockPlainText`'s
 * 1:1 text/position correspondence applies here unchanged), and `itemPos`
 * is the enclosing `list_item`'s own position, tracked ACROSS transactions
 * via `tr.mapping` (see `checklistHighlightPlugin`'s own `apply`) so an
 * edit anywhere else in the document — a different Entry line, a Reference
 * resolving — never mistakes this line for a different one and clears
 * `demoted` it shouldn't have.
 */
interface ChecklistHighlightState {
  readonly itemPos: number;
  readonly blockStart: number;
  readonly demoted: ReadonlySet<DemotedSignature>;
}

export const checklistHighlightPluginKey = new PluginKey<ChecklistHighlightState | null>(
  "composer-checklist-highlight",
);

/**
 * Whether `paragraph` already holds nothing but Promotion's own reference
 * mark — `entry-schema.ts`'s `task_reference` atom, alone or preceded only
 * by the mandatory separator whitespace the mark's own leading space
 * survives parsing as (the identical shape `promote-tasks.ts`'s own
 * `isAlreadyReferenced` checks, kept as a small local copy here rather
 * than an import: that module belongs to Promotion's own write path, this
 * one only ever READS a document that might already hold its output).
 * Opening an Entry that was already promoted for editing must never
 * re-tokenize the Task's own cached label as if it were prose the reader
 * just typed — those words belong to the Task, not to this line.
 */
function isTaskReferenceParagraph(paragraph: PMNode): boolean {
  const children: PMNode[] = [];
  paragraph.forEach((child) => {
    children.push(child);
  });
  const first = children[0];
  const own = first?.isText && (first.text ?? "").trim() === "" ? children.slice(1) : children;
  return own.length === 1 && own[0]?.type.name === "task_reference";
}

/**
 * Whether `$from` sits inside a checkbox item's own LEADING paragraph —
 * not a nested block (a note under the checkbox, `- [ ] milk\n  - 2%`),
 * which is ordinary prose with no tokens of its own to recognise, and not
 * a `task_reference` line (Promotion's own output, entry-schema.ts's
 * `task_reference` atom) — a referenced line is words the Task already
 * owns, not raw text `parseQuickAdd` has any business re-parsing. Mirrors
 * `checkboxInputRule`'s own "must be the item's own first child" check
 * (`$start.index(-1) !== 0`, above in this file) for the identical reason:
 * `list_item`'s content is `"paragraph block*"` (entry-schema.ts), so index
 * 0 is always that leading paragraph and nothing else ever is.
 */
function activeChecklistItem($from: ResolvedPos): { itemPos: number; blockStart: number } | null {
  if (!$from.parent.isTextblock || $from.parent.type.name !== "paragraph") {
    return null;
  }
  if ($from.depth < 1 || $from.index(-1) !== 0) {
    return null;
  }
  const grandParent = $from.node(-1);
  if (grandParent.type !== listItemNodeType || grandParent.attrs.checked === null) {
    return null;
  }
  if (isTaskReferenceParagraph($from.parent)) {
    return null;
  }
  return { itemPos: $from.before(-1), blockStart: $from.start() };
}

/**
 * Live highlighting on a checkbox line as you type — `- [ ] buy milk
 * tomorrow p1 #Shopping` — reusing #170's own parser and demotion rules,
 * and issue #179's own three-state live treatment
 * (`quick-add-highlight.ts`'s `tokenHighlightState`/`quickAddHighlightClass`),
 * per the ticket's own "reuse that logic; do not write a second parser
 * integration." What differs from `add-task-form.tsx` is only the
 * rendering surface: that file paints a `pointer-events-none` backdrop
 * `<div>` behind a real `<input>`, because a native text field has nowhere
 * to attach "this run is highlighted, in this state" other than a second,
 * hand-synchronized layer; a ProseMirror document has exactly that
 * attachment point built in — `Decoration.inline`, the same mechanism
 * `placeholderPlugin` (below) already uses for its own widget. The caret
 * offset `tokenHighlightState` needs comes for free here, unlike
 * add-task-form.tsx's own dedicated `caretOffset` state: `state.selection`
 * is already part of the `EditorState` `decorations(state)` is called
 * with, so there's no separate event to track it through.
 *
 * State tracks the ONE checklist line the caret is currently inside, the
 * same "one open thing at a time" shape `pickerPlugin`/`slashPlugin`
 * already use — an Entry can hold several checklist items, but only the
 * one being actively typed into needs live decoration; a line the reader
 * has moved away from keeps whatever plain markdown it already has, read
 * back correctly the next time `entryMarkdownToDocument` parses it (issue
 * #174's backfill migration is what turns an EXISTING plain checkbox into
 * a real Task; this plugin's own job ends at Send, same as `promoteTasks`,
 * promote-tasks.ts). Demotions are threaded through `tr.mapping` (not
 * recomputed from `previous.itemPos === itemPos` by raw equality) so an
 * edit anywhere ELSE in the document — a different paragraph, a Reference
 * resolving — never looks like "moved to a different item" and clears a
 * demotion the reader hasn't actually revisited.
 *
 * `handleClick` mirrors `add-task-form.tsx`'s own `handleInputClick`
 * exactly — the identical `tokenAtOffset`/`tokenSignature` pair, over the
 * identical flat text a `Decoration` is drawn against — but returns
 * `false` unconditionally rather than swallowing the click: ProseMirror's
 * own click handling still runs afterwards and places the caret exactly
 * where the reader tapped, the same behaviour a native `<input>` gives for
 * free and a `contenteditable` does not unless nothing upstream calls
 * `preventDefault`.
 */
export function checklistHighlightPlugin(): Plugin<ChecklistHighlightState | null> {
  return new Plugin<ChecklistHighlightState | null>({
    key: checklistHighlightPluginKey,
    state: {
      init: (): ChecklistHighlightState | null => null,
      apply(tr, previous, _oldState, newState): ChecklistHighlightState | null {
        const active = activeChecklistItem(newState.selection.$from);
        if (active === null) {
          return null;
        }
        const mappedPreviousItemPos = previous === null ? null : tr.mapping.map(previous.itemPos);
        const demotedSignature = tr.getMeta(checklistHighlightPluginKey) as
          | DemotedSignature
          | undefined;
        const carriedOver =
          previous !== null && mappedPreviousItemPos === active.itemPos
            ? previous.demoted
            : new Set<DemotedSignature>();
        const demoted =
          demotedSignature === undefined
            ? carriedOver
            : new Set([...carriedOver, demotedSignature]);
        return { itemPos: active.itemPos, blockStart: active.blockStart, demoted };
      },
    },
    props: {
      decorations(state) {
        const active = checklistHighlightPluginKey.getState(state);
        if (active === null || active === undefined) {
          return DecorationSet.empty;
        }
        const $blockStart = state.doc.resolve(active.blockStart);
        const text = textBlockPlainText($blockStart.parent);
        const result = parseWithDemotions(text, quickAddOptionsNow(), active.demoted);
        // A collapsed selection's own position, relative to this line's
        // own start — `null` for a range selection (nothing is "the
        // caret sitting inside one token" when more than one character is
        // selected), mirroring add-task-form.tsx's own `caretOffset` doc
        // comment for the identical reason.
        const caretOffset = state.selection.empty
          ? state.selection.$from.pos - active.blockStart
          : null;
        const decorations = result.tokens.flatMap((token) => {
          const className = quickAddHighlightClass(
            token.kind,
            tokenHighlightState(token, caretOffset),
          );
          if (className === undefined) {
            // "unresolved" (quick-add-highlight.ts's own doc comment):
            // left as plain, unstyled text — no Decoration at all, rather
            // than one carrying an empty class.
            return [];
          }
          return [
            Decoration.inline(active.blockStart + token.start, active.blockStart + token.end, {
              class: className,
            }),
          ];
        });
        return DecorationSet.create(state.doc, decorations);
      },
      handleClick(view, pos) {
        const active = checklistHighlightPluginKey.getState(view.state);
        if (active === null || active === undefined) {
          return false;
        }
        const offset = pos - active.blockStart;
        if (offset < 0) {
          return false;
        }
        const $blockStart = view.state.doc.resolve(active.blockStart);
        const text = textBlockPlainText($blockStart.parent);
        const result = parseWithDemotions(text, quickAddOptionsNow(), active.demoted);
        const token = tokenAtOffset(result.tokens, offset);
        if (token === undefined) {
          return false;
        }
        view.dispatch(view.state.tr.setMeta(checklistHighlightPluginKey, tokenSignature(token)));
        return false;
      },
    },
  });
}

/**
 * The ordinal position (0-based, document order) of the ONE checklist
 * item `checklistHighlightPluginKey` is actively tracking, plus that
 * item's own demoted-token signatures — or `null` when the caret isn't on
 * such a line — so `composer.tsx`'s own `send()` can hand both straight
 * to `promoteBareCheckboxes` (promote-tasks.ts) and have promotion agree
 * with whatever was highlighted a moment ago instead of silently
 * disagreeing with it.
 *
 * **Ordinal position, not the line's own text and not its live document
 * position.** `promoteBareCheckboxes` re-parses `body`
 * (`entryMarkdownToDocument`) from scratch, so the paragraph node
 * `active.itemPos` resolves to HERE and the paragraph that function later
 * visits at the "same" item are two different `Node` instances out of two
 * different parses of what is, after `entryDocumentToMarkdown`'s own
 * round trip, the identical document (promote-tasks.ts's own header
 * comment already leans on that round trip's stability) — `itemPos`
 * itself is meaningless outside this live `EditorState`, so it cannot be
 * the thing that survives. Nor can the line's own flattened text:
 * `textBlockPlainText` below renders a `[[` reference atom as a single
 * placeholder character rather than its raw markdown, where
 * promote-tasks.ts's own `flattenLabel` (its own comment explains why)
 * expands it to the full `[[…]]` — the two would not always agree on
 * what "this line's text" even is. Counting instead — "the Nth bare,
 * unreferenced checkbox item in document order" — sidesteps both: both
 * functions walk the identical document in the identical order and apply
 * the identical qualifying rule (`checked !== null` and not already a
 * `task_reference`, `activeChecklistItem`/`isTaskReferenceParagraph` here
 * mirroring `promoteBareCheckboxes`'s own `isAlreadyReferenced`), so the
 * Nth item found here is the Nth item `transformNode` there mints a Task
 * for, with nothing coordinate- or text-dependent in between.
 */
export function activeChecklistPromotion(
  state: EditorState,
): { readonly ordinal: number; readonly demoted: ReadonlySet<DemotedSignature> } | null {
  const active = checklistHighlightPluginKey.getState(state);
  if (active === null || active === undefined) {
    return null;
  }
  let ordinal = 0;
  let found: number | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type !== listItemNodeType || node.attrs.checked === null) {
      return true;
    }
    const first = node.firstChild;
    if (first === null || isTaskReferenceParagraph(first)) {
      return true;
    }
    if (pos === active.itemPos) {
      found = ordinal;
    }
    ordinal += 1;
    return true;
  });
  return found === null ? null : { ordinal: found, demoted: active.demoted };
}

// ---------------------------------------------------------------------------
// The empty-document placeholder
// ---------------------------------------------------------------------------

/**
 * Draws `text` as a widget decoration inside an entirely empty document —
 * never a native `placeholder` attribute, since that only has meaning on an
 * `<input>`/`<textarea>` and this is a `contenteditable` `<div>`. A widget
 * decoration is ProseMirror's own mechanism for DOM the document itself
 * doesn't own (it isn't part of the doc, isn't selectable text, and vanishes
 * the instant the first character is typed because `isEmpty` below then
 * reads `false`) — the standard alternative, a CSS `::before` keyed off an
 * empty paragraph, would need `:has()` to reach through the `<br>`
 * ProseMirror itself inserts into an empty textblock so the browser doesn't
 * collapse its line box, for no benefit over reading the doc directly here.
 */
function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const first = state.doc.firstChild;
        const isEmpty =
          state.doc.childCount === 1 &&
          first !== null &&
          first.type.name === "paragraph" &&
          first.content.size === 0;
        if (!isEmpty) {
          return DecorationSet.empty;
        }
        const widget = document.createElement("span");
        widget.className = "pointer-events-none select-none text-muted-foreground";
        widget.textContent = text;
        return DecorationSet.create(state.doc, [
          Decoration.widget(1, widget, { ignoreSelection: true }),
        ]);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// A paragraph's NodeView
// ---------------------------------------------------------------------------

/**
 * `entrySchema`'s `paragraph` spec (entry-schema.ts) has no `toDOM` either
 * — unlike `bullet_list`/`ordered_list`/`list_item`, which inherit theirs
 * from `prosemirror-schema-list`'s own base specs, `paragraph` is entirely
 * this ticket's to render. A NodeView with a `contentDOM` (rather than
 * adding `toDOM: () => ["p", 0]` to the shared schema) for the same reason
 * `referenceNodeView`'s own comment gives: keeping `entrySchema` itself
 * free of anything view-specific, since entry-document.ts's round-trip
 * tests build documents against this exact schema with no `EditorView` in
 * sight.
 */
export function paragraphNodeView(): NodeView {
  const dom = document.createElement("p");
  return { dom, contentDOM: dom };
}

// ---------------------------------------------------------------------------
// A task list item's checkbox
// ---------------------------------------------------------------------------

// `flex list-none items-baseline gap-1.5`, deliberately WITHOUT
// `entry-prose.tsx`'s own `-ml-5` — that negative margin is safe in
// History's read-only bubble, which never constrains horizontal overflow,
// but the Composer's own editable root sets `overflow-y-auto` for its
// 8-line scroll ceiling, and the CSS overflow spec forces a "visible"
// `overflow-x` to compute as `auto` the instant the OTHER axis is
// anything but `visible` — there is no way to opt back out of that
// coupling. `overflow-x: auto` clips content pulled left of the box's own
// start edge rather than letting it bleed into the padding the way it
// does in an unconstrained bubble, which silently pushed the checkbox
// out of its own hit-testable area — visible in the render, invisible to
// any assertion that doesn't actually try to click it. Playwright's
// `locator.click()` on the checkbox in apps/e2e's own composer.spec.ts
// caught this ("<div class=\"...items-end...\"> intercepts pointer
// events") where a same-origin `element.click()` — used only for a quick
// manual check while building this, never for real coverage — did not,
// because `.click()` has no notion of "is this pixel actually there."
// Losing the tight bullet-position alignment read mode gets is the
// trade: a task item's checkbox sits at the list's own ordinary indent
// instead, not smaller, but always exactly where it is drawn.
const TASK_LI_CLASS = "flex list-none items-baseline gap-1.5";
const TASK_CONTENT_CLASS = "min-w-0 flex-1";
const TASK_CHECKBOX_CLASS = "mt-[0.2em] shrink-0 accent-current";

/**
 * `list_item`'s own `<li>` DOES inherit a working `toDOM` from
 * `prosemirror-schema-list` (unlike `paragraph`/`reference`, just above and
 * below) — but that inherited `toDOM` is a bare `["li", 0]`, and knows
 * nothing about this schema's own `checked` attribute (entry-schema.ts's
 * own extension over the base spec). Left alone, a checklist typed in the
 * Composer would silently drop its checkbox entirely: the document model
 * would carry `checked` correctly (`entryDocumentToMarkdown` would still
 * serialize `- [ ] `/`- [x] ` right), but nothing on screen would show it
 * while writing — caught only by looking at the rendered editor, not by
 * any of this ticket's unit tests, which is exactly the class of defect
 * ADR 0036 already named once ("passed every test and was wrong on
 * screen").
 *
 * Mirrors `entry-prose.tsx`'s own `renderListItem` — same classes, same
 * layout (the checkbox beside the content in a flex row, not nested
 * inside the marker box a plain bullet would otherwise claim) — so a task
 * item looks identical whether it's being composed or being read. Unlike
 * that read-only renderer, the checkbox here is live: toggling it commits
 * straight through `setNodeMarkup`, the same one-attribute update
 * `checkboxInputRule` itself performs, rather than being wired through a
 * separate `onToggleTask` callback the way History's own tap-to-toggle is
 * — this is the Composer's own document, already mid-edit, so there is no
 * separate commit path to reach for.
 *
 * The checkbox sits OUTSIDE `contentDOM` (a sibling, inserted before it)
 * rather than inside it — ProseMirror only ever interprets DOM mutations
 * inside `contentDOM` as document edits, so building the checkbox as a
 * plain sibling is what keeps ProseMirror from ever mistaking a toggle (or
 * this function's own DOM writes reacting to `checked` changing) for a
 * paragraph edit.
 */
export function listItemNodeView(
  node: PMNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  const dom = document.createElement("li");
  const contentDOM = document.createElement("div");
  let checkbox: HTMLInputElement | null = null;

  function render(current: PMNode) {
    if (current.attrs.checked === null) {
      dom.className = "";
      contentDOM.className = "";
      checkbox?.remove();
      checkbox = null;
      if (contentDOM.parentElement !== dom) {
        dom.appendChild(contentDOM);
      }
      return;
    }
    dom.className = TASK_LI_CLASS;
    contentDOM.className = TASK_CONTENT_CLASS;
    if (checkbox === null) {
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = TASK_CHECKBOX_CLASS;
      checkbox.addEventListener("change", () => {
        const pos = getPos();
        if (pos === undefined) {
          return;
        }
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { checked: checkbox?.checked === true }),
        );
      });
    }
    checkbox.checked = current.attrs.checked === true;
    // `contentDOM` has to be inside `dom` BEFORE `insertBefore` names it as
    // the reference node, and on a freshly constructed task item it is not
    // yet: the constructor calls `render` before anything has attached it,
    // so this branch cannot assume the `checked === null` branch above ever
    // ran. Without this, `insertBefore` throws `NotFoundError` mid-render —
    // after `dom.className` was already set — and ProseMirror falls back to
    // putting the item's content straight into `dom`. The result is an `<li>`
    // wearing TASK_LI_CLASS (so `list-none`, so no bullet) with no checkbox
    // and no content wrapper: a list item that is neither a task nor a
    // bullet. That is what pressing Enter from a task item produced, which
    // made a checklist of more than one item impossible to write.
    if (contentDOM.parentElement !== dom) {
      dom.appendChild(contentDOM);
    }
    dom.insertBefore(checkbox, contentDOM);
  }

  render(node);
  return {
    dom,
    contentDOM,
    update(updatedNode) {
      if (updatedNode.type.name !== "list_item") {
        return false;
      }
      render(updatedNode);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// A Reference's NodeView
// ---------------------------------------------------------------------------

/**
 * `entrySchema`'s own `reference` node spec (entry-schema.ts) has no
 * `toDOM` — issue #154 built that schema purely for the two conversions,
 * with no editor view yet to render into. Supplying a NodeView here rather
 * than adding `toDOM` to the shared schema keeps the schema itself free of
 * anything view-specific (`entrySchema` is also used, headless, by
 * entry-document.ts's own round-trip tests), and a NodeView is the
 * standard place for exactly this: a leaf that renders its own `raw` text
 * — the literal `[[2026-08-28]]`/`[[e:<uuid>]]` characters, never a
 * resolved label, per ADR 0042 — as a single, non-editable unit a reader
 * can select or delete but never type inside.
 */
export function referenceNodeView(node: PMNode): NodeView {
  const span = document.createElement("span");
  span.className = "underline underline-offset-2 rounded-sm";
  span.dataset.reference = "true";
  span.contentEditable = "false";
  span.textContent = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
  return {
    dom: span,
    selectNode() {
      span.classList.add("bg-accent");
    },
    deselectNode() {
      span.classList.remove("bg-accent");
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Every plugin the Composer's `EditorView` needs, in the order that makes
 * `listKeymap`'s Enter AND Backspace bindings take priority over
 * `baseKeymap`'s own (issue #162 added the latter): two
 * separate `keymap()` plugins bound to the same key chain automatically —
 * ProseMirror tries each plugin's `handleKeyDown` prop in order and moves
 * to the next only if the current one returns `false` — so `listKeymap`
 * simply needs to be registered before `keymap(baseKeymap)`, not merged
 * into one combined bindings object.
 */
export function buildComposerPlugins(placeholder: string): Plugin[] {
  return [
    listKeymap(),
    historyKeymap(),
    formatKeymap(),
    keymap(baseKeymap),
    inputRules({ rules: buildInputRules() }),
    pickerPlugin(),
    // Registered after pickerPlugin() — slashPlugin()'s own comment
    // explains why the order is load-bearing, not incidental.
    slashPlugin(),
    // Issue #173: independent of picker/slash ordering — reads only its
    // own plugin state and the doc/selection, never either of theirs.
    checklistHighlightPlugin(),
    placeholderPlugin(placeholder),
    history(),
  ];
}
