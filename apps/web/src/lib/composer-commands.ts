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
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
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
// Marks: bold, italic, code
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
  code,
  bulletList,
  orderedList,
  checklist,
  indent,
  outdent,
  reference,
  undoCommand,
  redoCommand,
];
