/**
 * The Composer's editing actions, named and queryable, for issue #160.
 *
 * Before this module, composer-editor.ts (issue #155) had input rules and a
 * keymap and NOTHING ELSE: every action — toggle bold, wrap in a bullet
 * list, undo — was an anonymous expression wired directly into a keymap
 * binding or an `InputRule`'s callback, with no name a second caller could
 * ask for. That was fine as long as typing was the only way to trigger any
 * of it. It stops being fine the moment three separate tickets need to ask
 * the SAME question a different way: a format toolbar (#164) needs to know
 * "is bold on right now" to paint its own pressed state, a `/` menu (#165)
 * needs to list which actions currently apply so it can grey out the rest,
 * and a keyboard-shortcuts ticket (#162) needs "run this exact action" as a
 * key binding's target. Built without this module, each of those three
 * would grow its own copy of "what does toggling bold even mean here," and
 * the three copies would drift the same way `inline-markdown.ts`'s own
 * module comment warns a second Markdown parser would.
 *
 * This module is that one place. Every action is a `ComposerCommand`: a
 * stable `id`, a human `label`, `isActive` (is this mark/block applied at
 * the caret right now — a toolbar's pressed state), `isEnabled` (can it run
 * at all from here — a toolbar's disabled state or a menu's filter), and
 * `run`, a plain ProseMirror `Command` — `(state, dispatch?) => boolean`,
 * the same shape `toggleMark`/`wrapInList`/`undo` already have. Calling
 * `run(state)` with no `dispatch` is a dry run (every ProseMirror command
 * supports this by convention): it reports whether the action WOULD apply
 * without touching the document, which is exactly `isEnabled` for every
 * action below whose availability has no cheaper test than attempting it.
 *
 * Deliberately free of anything that needs a live `EditorView`: no DOM, no
 * `view.dispatch`, nothing that reads `view.state` instead of taking a
 * `state` parameter. jsdom cannot mount a ProseMirror `EditorView` at all
 * (ADR 0044) — no `Range`, no `Selection` — so every command here is built
 * and unit-tested against a plain `EditorState` constructed directly from
 * `entrySchema`, with a bare function standing in for `dispatch`. Anything
 * that genuinely needs a mounted view (actual keystrokes, actual focus)
 * stays in composer-editor.ts/composer.tsx and is covered by the e2e suite
 * instead, per this module's own share of ADR 0044's reasoning.
 *
 * This module does not import anything from composer-editor.ts, and
 * composer-editor.ts imports FROM this one (for the two bindings below that
 * can cleanly reach through it — see historyKeymap()/listKeymap()'s own
 * comments there). Keeping the dependency one-directional is deliberate:
 * composer-editor.ts's own keymap becomes just one more consumer of this
 * registry, same as the future toolbar and menu, rather than the two files
 * needing each other and risking a circular import between them. The two
 * node types this module and composer-editor.ts both need
 * (`list_item`, and `bullet_list`/`ordered_list`) are therefore looked up
 * here independently, through the same throw-on-typo pattern
 * composer-editor.ts's own module comment already established — safe only
 * because `entrySchema` (entry-schema.ts) is a single shared `Schema`
 * instance: `entrySchema.nodes.list_item` is the exact same `NodeType`
 * object wherever it's read from, so the two independent lookups can never
 * drift apart into two different types that happen to share a name.
 */
import { toggleMark } from "prosemirror-commands";
import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { MarkType, NodeType, Node as PMNode } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { entrySchema } from "@/lib/entry-schema";

// ---------------------------------------------------------------------------
// Typed schema access — see this module's own comment above for why this
// duplicates, rather than imports, composer-editor.ts's identical pattern.
// ---------------------------------------------------------------------------

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

const bulletListNodeType = requireNodeType("bullet_list");
const orderedListNodeType = requireNodeType("ordered_list");
const listItemNodeType = requireNodeType("list_item");

const strongMarkType = requireMarkType("strong");
const emMarkType = requireMarkType("em");
const codeMarkType = requireMarkType("code");
const strikethroughMarkType = requireMarkType("strikethrough");

// ---------------------------------------------------------------------------
// The registry's own shape
// ---------------------------------------------------------------------------

export interface ComposerCommand {
  /** Stable — a future keyboard-shortcut binding or a toolbar button's own React `key` can hang off this without caring about `label`'s wording ever changing. */
  id: string;
  /** Human-facing, e.g. for a toolbar button's tooltip or a `/` menu row. */
  label: string;
  /** Is this mark/block applied AT THE CARET (or throughout the selection) right now — a toolbar's pressed state. */
  isActive(state: EditorState): boolean;
  /** Can this action run from here at all — a toolbar's disabled state, or what a `/` menu filters its list down to. */
  isEnabled(state: EditorState): boolean;
  /** A plain ProseMirror `Command`: call with no `dispatch` for a dry run, or with one to actually apply it. */
  run: Command;
}

// ---------------------------------------------------------------------------
// Marks: bold, italic, strikethrough, code
// ---------------------------------------------------------------------------

/**
 * Whether `markType` applies at the current selection — the standard
 * ProseMirror reading (the same one `prosemirror-example-setup`'s own menu
 * uses, which isn't a dependency here, so this is a small hand-written
 * copy rather than a reason to add one): an EMPTY selection (a bare caret)
 * checks `state.storedMarks` first — the marks the NEXT typed character
 * would carry, which after e.g. `toggleMark` runs once can differ from
 * whatever mark the character immediately behind the caret happens to
 * have — falling back to the caret position's own resolved marks only when
 * nothing has been explicitly stored. A non-empty selection instead asks
 * whether the mark covers the ENTIRE range (`rangeHasMark`), matching what
 * `toggleMark` itself treats as "already on" when deciding whether running
 * it again would add or remove the mark.
 */
function markActive(state: EditorState, markType: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    return markType.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
  }
  return state.doc.rangeHasMark(from, to, markType);
}

function markCommand(id: string, label: string, markType: MarkType): ComposerCommand {
  const toggle = toggleMark(markType);
  return {
    id,
    label,
    isActive: (state) => markActive(state, markType),
    // `toggleMark`'s own Command, called with no `dispatch`, IS its own
    // availability check — there is no cheaper test than asking it.
    isEnabled: (state) => toggle(state),
    run: toggle,
  };
}

export const bold: ComposerCommand = markCommand("bold", "Bold", strongMarkType);
export const italic: ComposerCommand = markCommand("italic", "Italic", emMarkType);
export const strikethrough: ComposerCommand = markCommand(
  "strikethrough",
  "Strikethrough",
  strikethroughMarkType,
);
export const code: ComposerCommand = markCommand("code", "Code", codeMarkType);

// ---------------------------------------------------------------------------
// Lists: bulletList, orderedList, checklist
// ---------------------------------------------------------------------------

/** The nearest enclosing `list_item`, or `null` outside any list — the same "walk ancestors" `liftListItem`/`sinkListItem` themselves do internally, exposed here for the active/available checks below. */
function nearestListItem(state: EditorState): PMNode | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type === listItemNodeType) {
      return node;
    }
  }
  return null;
}

/** Whether an ancestor of the caret is a `listType` node — `bullet_list` or `ordered_list`, never `list_item` itself (a `list_item` can sit under either). */
function hasListAncestor(state: EditorState, listType: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    if ($from.node(depth).type === listType) {
      return true;
    }
  }
  return false;
}

/**
 * `list_item.checked` (entry-schema.ts) is `null` for a plain item and a
 * boolean for a task — the SAME node type either way, per that schema's
 * own module comment ("a task is a checkbox state on an otherwise ordinary
 * item, not a different kind of thing an item can be"). `bulletList` is
 * therefore only "active" for a PLAIN item, so its pressed state and
 * `checklist`'s own pressed state below are never both lit at once for the
 * same caret position.
 */
function bulletListActive(state: EditorState): boolean {
  const item = nearestListItem(state);
  return item !== null && item.attrs.checked === null && hasListAncestor(state, bulletListNodeType);
}

function orderedListActive(state: EditorState): boolean {
  return hasListAncestor(state, orderedListNodeType);
}

function checklistActive(state: EditorState): boolean {
  const item = nearestListItem(state);
  return item !== null && item.attrs.checked !== null;
}

/**
 * `bulletList`/`orderedList` toggle: wrap the selection in `listType` if
 * it isn't already inside one, or lift back out (`liftListItem`, the exact
 * command `outdent` below also runs) if it is. `isActive` is what decides
 * which half runs, so a toolbar button showing this action as "pressed"
 * and pressing it again is what turns it back off, the ordinary meaning of
 * a toggle button.
 */
function toggleListWrap(listType: NodeType, isActive: (state: EditorState) => boolean): Command {
  return (state, dispatch) => {
    if (isActive(state)) {
      return liftListItem(listItemNodeType)(state, dispatch);
    }
    return wrapInList(listType)(state, dispatch);
  };
}

const bulletListRun = toggleListWrap(bulletListNodeType, bulletListActive);
const orderedListRun = toggleListWrap(orderedListNodeType, orderedListActive);

export const bulletList: ComposerCommand = {
  id: "bulletList",
  label: "Bullet list",
  isActive: bulletListActive,
  isEnabled: (state) => bulletListRun(state),
  run: bulletListRun,
};

export const orderedList: ComposerCommand = {
  id: "orderedList",
  label: "Numbered list",
  isActive: orderedListActive,
  isEnabled: (state) => orderedListRun(state),
  run: orderedListRun,
};

/**
 * Sets `checked` on the nearest enclosing `list_item`, the same
 * single-attribute update `checkboxInputRule` (composer-editor.ts) and
 * `listItemNodeView`'s own live checkbox both already perform via
 * `setNodeMarkup` — this is a THIRD call site for that exact pattern, not
 * a fourth representation of "is this item a task."  Returns `false` (and
 * touches nothing) outside any list, the same "not part of this dialect's
 * grammar" refusal `checkboxInputRule`'s own comment gives for a bare
 * paragraph.
 */
function setCheckedOnEnclosingItem(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  checked: boolean | null,
): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === listItemNodeType) {
      if (dispatch) {
        const pos = $from.before(depth);
        dispatch(state.tr.setNodeMarkup(pos, undefined, { checked }).scrollIntoView());
      }
      return true;
    }
  }
  return false;
}

/**
 * Wraps the current selection in a fresh `bullet_list`, then marks every
 * top-level `list_item` that wrap just created as an (unchecked) task —
 * `checked: false` on each, never `true`: turning a plain paragraph into a
 * checklist starts every new item unchecked, the same starting state
 * `checkboxInputRule` gives `- [ ] ` (as opposed to `- [x] `, which this
 * command has no typed marker to read).
 *
 * Built on `wrapInList` itself rather than a second copy of its wrapping
 * logic: `wrapInList`'s own `dispatch` callback receives the SAME
 * `Transaction` it built internally (`state.tr`, mutated in place) — so
 * capturing it here rather than letting `wrapInList` dispatch it directly
 * leaves it open for exactly one more step, `setNodeMarkup` on each new
 * item, before this command dispatches the combined result itself. Marking
 * items this way (rather than passing `{ checked: false }` as the wrapping
 * node's own initial attrs) is required because those attrs belong to the
 * `bullet_list` `wrapInList` creates, not to the `list_item`s inside it —
 * `wrapInList`'s `attrs` parameter has nowhere to reach the children.
 */
function wrapAsChecklist(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const wrap = wrapInList(bulletListNodeType);
  if (!dispatch) {
    return wrap(state);
  }
  let wrapped: Transaction | null = null;
  if (!wrap(state, (tr) => (wrapped = tr))) {
    return false;
  }
  if (wrapped === null) {
    return false;
  }
  const tr: Transaction = wrapped;
  const { from, to } = state.selection;
  const start = tr.mapping.map(from);
  const end = tr.mapping.map(to);
  tr.doc.nodesBetween(start, end, (node, pos) => {
    if (node.type === listItemNodeType && node.attrs.checked === null) {
      tr.setNodeMarkup(pos, undefined, { checked: false });
    }
  });
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * `checklist`'s own run has three cases, decided by where the caret
 * already is — never a single `wrapInList` call, because "wrap in a
 * checklist" means something different depending on what's already there:
 *
 * - Already a task (`checklistActive`): turn the task OFF, `checked: null`
 *   — the item stays a plain bullet rather than being lifted out of the
 *   list entirely, since unchecking a task is not the same request as
 *   leaving the list.
 * - Already a plain bullet item (inside a list, `checked === null`): the
 *   list wrap this action would otherwise perform already happened: just
 *   add the checkbox, `checked: false`.
 * - Not in any list at all: `wrapAsChecklist` does both steps at once —
 *   wrap in a fresh `bullet_list`, then mark its new items as tasks.
 */
const checklistRun: Command = (state, dispatch) => {
  if (checklistActive(state)) {
    return setCheckedOnEnclosingItem(state, dispatch, null);
  }
  if (nearestListItem(state) !== null) {
    return setCheckedOnEnclosingItem(state, dispatch, false);
  }
  return wrapAsChecklist(state, dispatch);
};

export const checklist: ComposerCommand = {
  id: "checklist",
  label: "Checklist",
  isActive: checklistActive,
  isEnabled: (state) => checklistRun(state),
  run: checklistRun,
};

/**
 * Flips a task's own `checked` between `true` and `false` — issue #164's
 * `Mod-Shift-Enter`, composer-editor.ts's own keymap. Deliberately NOT one
 * of `composerCommands`' own entries — unlike `softBreak` below (issue
 * #212), which IS one despite also having no toolbar button yet, this
 * action has no future toolbar button OR `/` menu row planned for it at
 * all: the ticket gives it a chord and nothing else, the same way
 * `bulletList`/`orderedList`/`checklist` above get a button and no chord —
 * the two are reached by different, non-overlapping paths, not duplicated
 * across both. It's exported and named like the registry's own entries
 * anyway (rather than kept as a bare `Command` closure in
 * composer-editor.ts) so a keyboard-shortcuts settings screen, if one is
 * ever built, has a `label` to show without composer-editor.ts having to
 * invent one.
 *
 * A no-op — `false`, nothing dispatched — outside a task item entirely:
 * neither a plain bullet (`checked === null`) nor bare text has a checked
 * state to flip, the same refusal `setCheckedOnEnclosingItem` itself
 * documents for "not part of this dialect's grammar here." Pressing
 * `Mod-Shift-Enter` in a plain paragraph therefore does exactly nothing,
 * rather than e.g. turning it into a checked task — that's `checklist`'s
 * job, reached a different way, and this command must not quietly do it.
 */
const toggleCheckboxDoneRun: Command = (state, dispatch) => {
  const item = nearestListItem(state);
  if (item === null || item.attrs.checked === null) {
    return false;
  }
  return setCheckedOnEnclosingItem(state, dispatch, !item.attrs.checked);
};

export const toggleCheckboxDone: ComposerCommand = {
  id: "toggleCheckboxDone",
  label: "Toggle checkbox done",
  isActive: (state) => {
    const item = nearestListItem(state);
    return item !== null && item.attrs.checked === true;
  },
  isEnabled: (state) => {
    const item = nearestListItem(state);
    return item !== null && item.attrs.checked !== null;
  },
  run: toggleCheckboxDoneRun,
};

/**
 * `Enter` on a `list_item`, wired to composer-editor.ts's `listKeymap()`
 * instead of the bare `splitListItem(listItemNodeType)` it used to bind
 * directly — issue #210. Continuing a DONE checklist item must start the
 * new item unchecked (UpNote's own behaviour, and the only reading of
 * ADR 0053 consistent with "every checkbox is a Task": minting an
 * already-completed Task on every Enter would make finishing a checklist
 * item and pressing Enter silently create a second done Task nobody
 * asked for).
 *
 * This is NOT fixable by passing `itemAttrs` to `splitListItem` itself
 * (verified by reading prosemirror-schema-list's own source, not
 * assumed): `itemAttrs` is only spliced into the SECOND split node's type
 * when `$to.pos == $from.end()` — caret at the very end of the item's
 * text. A split further back (this function's own "middle of a ticked
 * item's text" acceptance case) takes the earlier "delete the selection,
 * then `canSplit`/`split` with no `types` override" path instead, which
 * copies the ORIGINAL node's type and attrs onto both halves — no
 * `itemAttrs` involved at all, so passing one there would silently do
 * nothing for exactly the case this function most needs to handle. And a
 * STATIC `{ checked: false }`, even where `itemAttrs` is honoured, cannot
 * tell "was already a task" from "is a plain bullet": it would turn
 * Enter on a plain bullet (`checked: null`) into a checkbox, which is not
 * this ticket's ask and not UpNote's own behaviour either.
 *
 * The fix instead reads the ORIGINAL item's `checked` before splitting,
 * runs the real `splitListItem(listItemNodeType)` with a capturing
 * `dispatch` (the same "borrow the transaction `wrapInList` already
 * built, then add one more step before dispatching it" shape
 * `wrapAsChecklist` above uses), and — only when that original was
 * `checked === true` — patches the NEW item (found by resolving the
 * captured transaction's own post-split selection, which
 * `splitListItem`'s own two branches both leave sitting inside the new
 * item: either the default "selection maps through the steps" behaviour
 * every `Transaction` gives for free, or that branch's own explicit
 * `tr.setSelection` into the freshly created empty textblock) back down
 * to `checked: false`.
 *
 * Returns `false` unchanged, dispatching nothing, whenever the real
 * `splitListItem` itself would — most importantly the empty-top-level-item
 * case its own doc comment describes as "bail out and let next command
 * handle lifting," which is exactly what lets `composer-editor.ts`'s
 * `listChain` (`chainCommands(splitListItemUnchecked, outdent.run)`) still
 * fall through to `outdent.run` there, unchanged from before this
 * function existed.
 */
export const splitListItemUnchecked: Command = (state, dispatch) => {
  const split = splitListItem(listItemNodeType);
  if (!dispatch) {
    return split(state);
  }
  const originalItem = nearestListItem(state);
  let captured: Transaction | null = null;
  if (!split(state, (tr) => (captured = tr))) {
    return false;
  }
  if (captured === null) {
    return false;
  }
  const tr: Transaction = captured;
  if (originalItem !== null && originalItem.attrs.checked === true) {
    const $from = tr.selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type === listItemNodeType) {
        tr.setNodeMarkup($from.before(depth), undefined, { checked: false });
        break;
      }
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
};

// ---------------------------------------------------------------------------
// Soft break — Enter outside a list, issue #212
// ---------------------------------------------------------------------------

/**
 * Enter's new meaning outside a list (issue #212, `listKeymap` in
 * composer-editor.ts): insert a literal `\n` into the CURRENT paragraph
 * rather than splitting it into two. Two of these in a row therefore give
 * `\n\n` — a genuine blank line under the `white-space: pre-wrap` every
 * prose surface already sets — where one used to give a paragraph split
 * that serialized to the very same `\n\n` on Send (a required separator,
 * since a lone `\n` is a CommonMark lazy continuation) and so ALSO rendered
 * as a blank line on the very first Enter. See ADR 0066 for the full
 * account of why the fix belongs at the keystroke rather than in
 * `collectBlocks`, the reader's own block-merging step, which already
 * copies a blank line through verbatim and needs nothing changed here.
 *
 * `replaceSelectionWith(…, false)` — the `false` is `inheritMarks: false`,
 * and it is load-bearing, not a default left alone: `Transaction`'s own
 * implementation (verified by reading `prosemirror-state`'s source, not
 * assumed), when `inheritMarks` is `true` (its actual default), calls
 * `node.mark(this.storedMarks ?? …)` on whatever node it was handed —
 * OVERWRITING this function's own carefully-`code`-stripped mark set with
 * the caret's raw stored marks, `code` included, right back. Passing
 * `false` is what keeps the marks this function computed below actually
 * the ones that land on the inserted character.
 *
 * Marks are inherited from the caret's own stored/resolved marks — the
 * same read `markActive` above already uses — MINUS `code`. Every other
 * mark (`strong`, `em`, `strikethrough`) continuing across a soft break is
 * the wanted behaviour (typing stays bold on the next line); `code` is
 * excluded on purpose: a code span's own backtick-fence length
 * (`entry-document.ts`'s `writeCodeSpan`) is chosen long enough to beat
 * every backtick run ALREADY inside the span, and a newline inside one is
 * invisible to that choice today — a later edit that has to widen the
 * fence to dodge a sequence spanning the newline's own neighbours would be
 * a silent content edit for a keystroke that looks, on screen, like
 * nothing more than moving to the next line.
 *
 * Dispatched as a plain document edit — never through `handleTextInput`,
 * the way a typed character reaches `prosemirror-inputrules` — so it can
 * never itself re-trigger an input rule. That matters concretely for step
 * 3's re-anchored line-start rules just below: those rules match against
 * `\n` appearing in the SAME textblock's own text, which this command is
 * what puts there in the first place, but the `\n` itself is never the
 * character an input rule's own trailing-space/trailing-marker match
 * looks for, so dispatching it this way cannot loop back into firing one.
 *
 * Returns `false` outside a textblock (mirrors `insertReferenceTrigger`'s
 * own identical guard above) — there is nowhere to insert a character
 * into a `bullet_list` or `list_item` itself, only into the textblock
 * nested inside one, and the caret is always resolved to some textblock
 * whenever this command is reachable through `listKeymap`'s own chain in
 * the first place.
 */
export const insertSoftBreak: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.isTextblock) {
    return false;
  }
  if (dispatch) {
    const marks = (state.storedMarks ?? state.selection.$from.marks()).filter(
      (mark) => mark.type !== codeMarkType,
    );
    dispatch(state.tr.replaceSelectionWith(entrySchema.text("\n", marks), false).scrollIntoView());
  }
  return true;
};

export const softBreak: ComposerCommand = {
  id: "softBreak",
  label: "Insert line break",
  // No caret position is ever "already" a soft break the way a mark or a
  // list wrap is — inserting a character has no pressed state to report,
  // the same reasoning `reference`'s own `isActive` above gives.
  isActive: () => false,
  isEnabled: (state) => insertSoftBreak(state),
  run: insertSoftBreak,
};

// ---------------------------------------------------------------------------
// Indent / outdent — registered here per issue #160; Tab/Shift-Tab/
// Ctrl-]/Ctrl-[/Backspace are bound to these through composer-editor.ts's
// `listKeymap()`, per issue #162.
// ---------------------------------------------------------------------------

const indentRun = sinkListItem(listItemNodeType);
const outdentRun = liftListItem(listItemNodeType);

export const indent: ComposerCommand = {
  id: "indent",
  label: "Indent",
  // Sinking a list item one level deeper is a one-shot action, not a
  // property a caret position either has or doesn't — there is no sense
  // in which this button is ever "pressed," so `isActive` is always
  // `false` rather than trying to invent a meaning for it.
  isActive: () => false,
  isEnabled: (state) => indentRun(state),
  run: indentRun,
};

export const outdent: ComposerCommand = {
  id: "outdent",
  label: "Outdent",
  isActive: () => false,
  isEnabled: (state) => outdentRun(state),
  run: outdentRun,
};

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

/**
 * "Insert a Reference" reaches for the SAME mechanism a hand-typed `[[`
 * already does, rather than constructing a `reference` node directly: this
 * command types the two trigger characters at the caret and stops there.
 * composer-editor.ts's `pickerPlugin` re-derives its own state from the
 * document on every transaction it's mounted against (its own module
 * comment), so a `[[` inserted this way opens the exact same dropdown a
 * person typing it by hand would see, with the exact same query-narrowing
 * and Enter-to-choose behaviour — one trigger path, not two. Building a
 * bare `reference` node here instead would need this module to invent
 * attrs for a Reference that points nowhere, and would give a `/` menu or
 * toolbar button a completely different insertion experience (no picker,
 * no way to choose WHICH date or Entry) than typing `[[` by hand already
 * has.
 */
const insertReferenceTrigger: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.isTextblock) {
    return false;
  }
  if (dispatch) {
    const { from, to } = state.selection;
    dispatch(state.tr.insertText("[[", from, to).scrollIntoView());
  }
  return true;
};

export const reference: ComposerCommand = {
  id: "reference",
  label: "Reference",
  // Inserting the picker's trigger text has no "already applied" state to
  // report — unlike a mark or a list wrap, there is nothing at the caret
  // for this action to be currently active AS.
  isActive: () => false,
  isEnabled: (state) => insertReferenceTrigger(state),
  run: insertReferenceTrigger,
};

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export const undoCommand: ComposerCommand = {
  id: "undo",
  label: "Undo",
  isActive: () => false,
  // `undoDepth`/`redoDepth` (prosemirror-history) are the documented,
  // O(1) way to ask "is there anything to undo/redo" — cheaper than a dry
  // run of `undo`/`redo` themselves, which would rebuild the transaction
  // just to throw it away.
  isEnabled: (state) => undoDepth(state) > 0,
  run: undo,
};

export const redoCommand: ComposerCommand = {
  id: "redo",
  label: "Redo",
  isActive: () => false,
  isEnabled: (state) => redoDepth(state) > 0,
  run: redo,
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every editing action, in the order the ticket lists them — a toolbar can
 * render this straight across, a `/` menu can filter it by `isEnabled`,
 * and a keyboard-shortcut binding can `.find(c => c.id === "bold")` (or a
 * caller that wants that indexed can build a `Map` from this once, rather
 * than this module keeping one it would otherwise have to keep in sync
 * with the list below by hand).
 */
export const composerCommands: readonly ComposerCommand[] = [
  bold,
  italic,
  strikethrough,
  code,
  bulletList,
  orderedList,
  checklist,
  indent,
  outdent,
  reference,
  softBreak,
  undoCommand,
  redoCommand,
];
