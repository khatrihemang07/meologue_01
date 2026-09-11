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
import { chainCommands, toggleMark } from "prosemirror-commands";
import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { MarkType, NodeType, Node as PMNode } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Command, Transaction } from "prosemirror-state";
import { AllSelection, EditorState, TextSelection } from "prosemirror-state";
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
const paragraphNodeType = requireNodeType("paragraph");

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

// ---------------------------------------------------------------------------
// Multi-block selections — issue #235, ADR 0072.
//
// Every command above this point was written, and tested, against a single
// caret or an in-block selection only — issue #160's own module comment
// never anticipated a selection spanning more than one top-level block, and
// nothing before issue #235 gave this Composer a way to build one from the
// keyboard alone (composer.spec.ts's own `pressSequentially` vocabulary is
// single-position). That gap is exactly what issue #230/ADR 0072 found
// UpNote itself gets wrong in three different ways for a real, mouse- or
// Cmd+A-built multi-block selection: `Cmd+7`/`Cmd+8`/`Cmd+Shift+9`
// convert N blocks to N items correctly on both platforms (Gap sweep #2
// Group G1/G2), but un-listing a flat list collapses to ONE `<br>`-joined
// block on macOS (Group G3) and un-listing a NESTED list alternates
// between stripping a level and re-normalising back to fully nested
// (Group I1) rather than flattening monotonically — and Tab across a
// multi-block plain-prose selection destroys both blocks' text outright
// (Group K1), reproduced 2/2 on both platforms. The helpers below give
// `bulletList`/`orderedList`/`checklist`/`insertEmSpace` a real multi-block
// code path for the first time, built to avoid all three.
// ---------------------------------------------------------------------------

/**
 * Whether the selection spans more than one textblock — the boundary this
 * module uses everywhere below between "an ordinary single-item toggle"
 * (every existing command's own tested behaviour, left completely
 * unchanged) and "a multi-block command" (new here). Counts every
 * `paragraph` `nodesBetween` the selection touches, rather than comparing
 * `$from`'s and `$to`'s own block-range siblings: a `blockRange` computed
 * at the SHARED ancestor depth collapses an entire nested list — however
 * many items deep — into a single "one child of `doc`" span (the shared
 * ancestor IS the outer `bullet_list`), which would wrongly read a
 * select-all of a 3-level nested list as a single-block selection. Counting
 * touched paragraphs instead treats "one item" and "one deeply-nested item"
 * the same way regardless of depth, which is what a person selecting text
 * actually did.
 *
 * **An `AllSelection` — `prosemirror-commands`' own `selectAll`, what a
 * real Cmd+A/Ctrl+A keypress actually produces (verified live, in a real
 * browser, not assumed) — always counts as multi-block here, even when it
 * happens to cover only one paragraph.** This is load-bearing, not a
 * cosmetic branch: an `AllSelection`'s own `$from`/`$to` resolve to
 * `doc.resolve(0)`/`doc.resolve(doc.content.size)` — DEPTH 0, genuinely
 * outside any `list_item` structurally, regardless of what the selection
 * visually covers — so every one of this file's existing single-item
 * checks that read `$from`'s own ancestor chain (`hasListAncestor`,
 * `nearestListItem`, and everything built on them) silently reports "not
 * in a list" for an `AllSelection` over a single already-listed item, a
 * real bug caught live against a real browser (Cmd+A over one bullet
 * item, then the Bullet List toolbar button read disabled) rather than
 * assumed from reading the code. Every fixture in this ticket's own
 * documentation and test suite builds its multi-block selection with
 * exactly this gesture — "Cmd+A, then the chord" — so treating it as
 * multi-block unconditionally is what makes the one-item case behave
 * exactly like the many-item case: consistently routed through the
 * `nodesBetween`-based helpers below, which read raw positions rather than
 * a depth-sensitive anchor and are correct for `AllSelection` by
 * construction. An ordinary, PARTIAL text selection confined to one item
 * (a click-drag over one word) is a ordinary `TextSelection`, not an
 * `AllSelection`, and is unaffected — it still returns `false` here
 * whenever it touches only one paragraph, preserving every existing
 * single-item test's own behaviour unchanged.
 */
function selectionSpansMultipleBlocks(state: EditorState): boolean {
  if (state.selection instanceof AllSelection) {
    return true;
  }
  const { from, to } = state.selection;
  let count = 0;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type === paragraphNodeType) {
      count += 1;
    }
  });
  return count > 1;
}

/** Whether ANY position within the selection has a `listType` ancestor — the range counterpart to `hasListAncestor`'s single-position walk, used only to decide a MULTI-block toggle's direction (below); single-item toggles keep using `hasListAncestor`/`bulletListActive`/`orderedListActive` unchanged. */
function rangeTouchesListType(state: EditorState, listType: NodeType): boolean {
  const { from, to } = state.selection;
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type === listType) {
      found = true;
    }
  });
  return found;
}

/**
 * Lifts every TOP-LEVEL `listType` list the selection touches, one level
 * each — the multi-block replacement for a bare `liftListItem(state,
 * dispatch)` call, needed because plain `liftListItem` refuses a selection
 * whose own `$from`/`$to` don't share a single list ancestor
 * (`prosemirror-schema-list`'s own `$from.blockRange` requirement — verified
 * directly, not assumed, against exactly the case this function exists
 * for). That case is not an edge case here: it is the SECOND press of
 * repeatedly un-listing a nested selection, every time. After the first
 * press outdents the outermost item fully to plain text (it had only one
 * level to lose), the very next press's own selection spans a plain
 * paragraph AND a `bullet_list` sibling together — content
 * `liftListItem` alone cannot process as one range, but which very much
 * needs its still-nested part to keep outdenting for issue #235's own
 * "flatten predictably, one level per press" to hold beyond the first
 * press.
 *
 * Scopes a `liftListItem` call to EACH touched top-level list's own
 * content range individually — never to the raw selection, and never
 * touching an already-plain sibling block at all — and stitches every
 * successful call's own steps onto ONE accumulating transaction. Lists are
 * processed in REVERSE document order deliberately: lifting a list can
 * only shrink positions AT OR AFTER its own range, never before it, so a
 * range computed from the pristine `state.doc` for a list earlier in the
 * document stays valid to apply directly — with no position mapping
 * needed — as long as every list AFTER it was already processed first,
 * the identical "insert/lift from the end backward" invariant
 * `insertEmSpace`'s own multi-block branch (above) already relies on.
 */
function liftEveryTouchedTopLevelList(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  listType: NodeType,
): boolean {
  const { from, to } = state.selection;
  const ranges: { start: number; end: number }[] = [];
  state.doc.forEach((node, offset) => {
    if (node.type === listType) {
      const start = offset;
      const end = offset + node.nodeSize;
      if (start < to && end > from) {
        ranges.push({ start, end });
      }
    }
  });
  if (ranges.length === 0) {
    return false;
  }
  if (!dispatch) {
    return true;
  }
  const tr = state.tr;
  let appliedAny = false;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i];
    if (range === undefined) {
      continue;
    }
    // Positions just INSIDE the list's own opening/closing tokens, so the
    // scoped selection below sits entirely within the list's own items —
    // never touching a plain sibling block before or after it.
    const innerFrom = Math.min(range.start + 1, state.doc.content.size);
    const innerTo = Math.max(innerFrom, Math.min(range.end - 1, state.doc.content.size));
    const scoped = EditorState.create({
      schema: entrySchema,
      doc: state.doc,
      selection: TextSelection.create(state.doc, innerFrom, innerTo),
    });
    let stepTr: Transaction | null = null;
    const applied = liftListItem(listItemNodeType)(scoped, (t) => {
      stepTr = t;
    });
    if (applied && stepTr !== null) {
      appliedAny = true;
      const steps: Transaction = stepTr;
      for (const step of steps.steps) {
        tr.step(step);
      }
    }
  }
  if (!appliedAny) {
    return false;
  }
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Whether `item` (a `list_item`) is a REFERENCED checklist line — Promotion's
 * own `task_reference` atom sitting alone in its leading paragraph (ADR
 * 0048), rather than a bare, still-just-typed checkbox — duplicated from
 * composer-editor.ts's own identical `isReferencedTaskItem`/
 * `isTaskReferenceParagraph` pair, per this module's own "independent
 * lookups, never an import" pattern (this module's own header comment).
 * This copy is safety-critical, not merely a style choice: the multi-block
 * checklist flip-all below (`multiBlockChecklistRun`) must never touch a
 * referenced item's own `checked` attribute, because that attribute is a
 * CACHE of a real Task's completion (entry-schema.ts's own `task_reference`
 * attrs comment — "a task reference's `label` and `checked` are *caches*,
 * rewritten [from the Task]"), never a fact this command is entitled to
 * invent on its own. Editing an already-Sent Entry re-opens the identical
 * ProseMirror document this command runs against (`commitEntryEdit`,
 * use-history.ts), so a promoted checklist item IS reachable from here —
 * this guard is what keeps the chord from ever writing a false completion
 * cache into one, the concrete mechanism behind "the flip-all applies to
 * the Composer's own in-progress document, where no Task exists yet" (ADR
 * 0053's own checkbox-is-a-Task rule, narrowed here for exactly this
 * reason).
 */
function isReferencedChecklistItem(item: PMNode): boolean {
  const paragraph = item.firstChild;
  if (paragraph === null) {
    return false;
  }
  const children: PMNode[] = [];
  paragraph.forEach((child) => {
    children.push(child);
  });
  const first = children[0];
  const own = first?.isText && (first.text ?? "").trim() === "" ? children.slice(1) : children;
  return own.length === 1 && own[0]?.type.name === "task_reference";
}

/** Whether the selection touches any checklist `list_item` (`checked !== null`) at all — decides whether a multi-block `checklist` run flips checked states (UpNote's own behaviour, narrowed pre-Send — see `multiBlockChecklistRun`) or instead builds a brand-new checklist from N plain blocks. */
function rangeTouchesChecklistItem(state: EditorState): boolean {
  const { from, to } = state.selection;
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type === listItemNodeType && node.attrs.checked !== null) {
      found = true;
    }
  });
  return found;
}

/** Whether the selection touches any `list_item` AT ALL, checklist or plain (`checked === null`) — found live, driving a real browser: a selection that touches a PLAIN bullet/numbered list (built via typed markers, never yet a checklist) needs a THIRD case in `multiBlockChecklistRun` below, distinct from both "already a checklist" (`rangeTouchesChecklistItem`) and "touches no list at all" (`wrapAsChecklist`'s own case) — see that function's own comment for the bug this fixes. */
function rangeTouchesAnyListItem(state: EditorState): boolean {
  const { from, to } = state.selection;
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type === listItemNodeType) {
      found = true;
    }
  });
  return found;
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
/**
 * `bulletListActive`/`orderedListActive`/`checklistActive` each start with
 * the identical `AllSelection` guard, for the identical reason
 * `selectionSpansMultipleBlocks`'s own comment (above) already gives in
 * full: a real Cmd+A/Ctrl+A keypress builds an `AllSelection`, whose
 * `$from`/`$to` sit at depth 0 regardless of what the selection visually
 * covers, so every check below that reads `$from`'s own ancestor chain
 * would otherwise report "not in a list" for a Cmd+A selection over
 * content that plainly is one — caught live, in a real browser, as a
 * toolbar button that correctly stopped being disabled once `toggleListWrap`
 * learned this same lesson, but still rendered its OWN pressed state
 * wrong (`isActive`, read completely independently by
 * `computeCommandStates`, composer.tsx). Delegating to the identical
 * `rangeTouchesListType`/`rangeTouchesChecklistItem` helpers the RUN
 * direction already uses keeps the toolbar's pressed state answering the
 * exact same question a click on it would act on — "would pressing this
 * button un-list?" — rather than the two ever being able to disagree.
 */
function bulletListActive(state: EditorState): boolean {
  if (state.selection instanceof AllSelection) {
    return rangeTouchesListType(state, bulletListNodeType);
  }
  const item = nearestListItem(state);
  return item !== null && item.attrs.checked === null && hasListAncestor(state, bulletListNodeType);
}

function orderedListActive(state: EditorState): boolean {
  if (state.selection instanceof AllSelection) {
    return rangeTouchesListType(state, orderedListNodeType);
  }
  return hasListAncestor(state, orderedListNodeType);
}

function checklistActive(state: EditorState): boolean {
  if (state.selection instanceof AllSelection) {
    return rangeTouchesChecklistItem(state);
  }
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
 *
 * A selection spanning more than one block (`selectionSpansMultipleBlocks`,
 * issue #235) takes a DIFFERENT direction test — `rangeTouchesListType`,
 * "does ANY part of the selection already sit inside a `listType` list,"
 * rather than `isActive`'s single-position ancestor walk — and, once that
 * holds, ALWAYS lifts, never re-wraps, no matter how the resulting
 * selection ends up mixed. This is deliberate, and it is where this
 * Composer diverges from UpNote on the record (ADR 0072):
 *
 * - UpNote's own un-list toggle, applied to N sibling items built from N
 *   plain blocks, does not give the blocks back: macOS's Cmd+7 fuses all N
 *   items' text into ONE `<br>`-joined block (Gap sweep #2 Group G3);
 *   Android's own toolbar button restores N separate blocks instead (Group
 *   G3, that platform's own gap sweep). This Composer copies Android's
 *   result, the non-lossy one — `liftEveryTouchedTopLevelList` (below) on
 *   a full-selection range lifts every selected sibling item into its OWN
 *   block, the identical result plain `liftListItem` (unchanged from
 *   before this ticket) already gave for this flat, single-list case; the
 *   new helper only has to do more work once nesting is involved (next
 *   bullet).
 * - UpNote's own repeated un-list on a NESTED selection alternates between
 *   outdenting one level (selection uniformly listed) and re-normalising
 *   the whole selection back to fully nested (selection left mixed after
 *   the previous press) — Gap sweep #2 Group I1, five presses to flatten a
 *   3-level list. Testing "isActive at $from" for direction — the ordinary
 *   single-item rule — reproduces that exact alternation here too: once
 *   the outermost item outdents to plain text, $from (still anchored at
 *   the selection's own start) no longer has a list ancestor, so the next
 *   press would call `wrapInList` and re-nest everything. Testing
 *   `rangeTouchesListType` instead — "is ANY part of the selection still
 *   in a `listType` list," not just where the selection starts — is half
 *   of what keeps every press an outdent for as long as ANY nested content
 *   remains. The other half is `liftEveryTouchedTopLevelList` itself: once
 *   the outermost item of a nested selection outdents to plain text, the
 *   REMAINING selection spans a plain paragraph and a `bullet_list`
 *   sibling together, a range plain `liftListItem` refuses outright
 *   (verified directly — its own `$from.blockRange` needs a single shared
 *   list ancestor for the WHOLE selection, which a plain+list mix does not
 *   have). `liftEveryTouchedTopLevelList` scopes each call to the
 *   still-listed part only, never touching the already-plain sibling,
 *   which is what makes every press outdent exactly one level — three
 *   presses to flatten a 3-level list, not UpNote's own five-press
 *   alternation — the "flatten predictably, one level per press" behaviour
 *   issue #235 asks for.
 */
function toggleListWrap(listType: NodeType, isActive: (state: EditorState) => boolean): Command {
  return (state, dispatch) => {
    if (selectionSpansMultipleBlocks(state)) {
      if (rangeTouchesListType(state, listType)) {
        return liftEveryTouchedTopLevelList(state, dispatch, listType);
      }
      return wrapInList(listType)(state, dispatch);
    }
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
 * The multi-block `checklist` chord (issue #235) — UpNote's own checklist
 * un-list refusal, copied deliberately, narrowed pre-Send. UpNote's own
 * `Cmd+Shift+9`, applied to an already-checklisted selection, never
 * un-lists at all (Gap sweep #2 Group G3/I3: "checklist fundamentally does
 * not use this chord to exit the list") — it instead flips every selected
 * item's `data-checked`, uniformly: a MIXED selection activates every item
 * to checked, a UNIFORM selection flips it. This Composer copies that
 * exactly, EXCEPT for a `list_item` whose leading paragraph is a
 * `task_reference` (`isReferencedChecklistItem` above) — a promoted line
 * with a real Task behind it, reachable here because editing an already-Sent
 * Entry re-opens the identical document (`commitEntryEdit`, use-history.ts).
 * Flipping that item's own `checked` would silently desync its cache from
 * the Task ADR 0048 says owns that fact, with no promotion gesture in
 * sight — ADR 0053's own reasoning for why the backfill needed a
 * confidence gate, applied here to a keyboard chord instead of a
 * migration. `list_item`s that ARE a task_reference are simply skipped:
 * never flipped, never lifted, never treated as "not a checklist item" for
 * the purpose of the "never un-list a checklist" refusal either — the
 * command still recognises the selection as a checklist selection and
 * still refuses to lift it out, it just leaves that one item's cache
 * exactly as it already was.
 *
 * Before ANY checklist item has been Sent — the overwhelmingly common
 * case this chord exists for, an in-progress Composer draft with nothing
 * promoted yet — every touched item is bare, so the guard above is a
 * no-op and every item flips, matching UpNote exactly. "Bounded to
 * pre-Send" is therefore not a special mode this command switches into;
 * it falls out of the guard applying uniformly whether the document being
 * edited has ever been Sent or not.
 *
 * A selection touching NO checklist item at all is a THIRD case, decided by
 * `convertTouchedContentToChecklist` (below) rather than by `wrapAsChecklist`
 * directly — a real gap `wrapAsChecklist` alone cannot cover, found live,
 * driving a real browser, not assumed: a selection can touch content that is
 * ALREADY a plain (non-checklist) list — built with a typed `- ` marker,
 * `checked === null` on every item — and `wrapAsChecklist` is built on
 * `wrapInList`, which assumes the range is NOT already wrapped in a list of
 * the type it is trying to build. Calling it on an existing `bullet_list`
 * selection fails outright (`findWrapping`, prosemirror-transform, has no
 * wrapping to offer for content that is already the target shape one level
 * up), which surfaced as the Checklist toolbar button going flatly disabled
 * the moment a reader selected an existing plain list and tried to convert
 * it — exactly the class of gap this ticket exists to close, not open a new
 * one of. `convertTouchedContentToChecklist` instead handles BOTH remaining
 * shapes a "no checklist touched" selection can hold: a top-level plain
 * paragraph (wrapped fresh, exactly as `wrapAsChecklist` already would) and
 * an EXISTING plain list item (`checked === null`) at any depth, converted
 * in place — `setNodeMarkup`, not a rebuild — since it already has
 * everywhere it needs to live.
 */
function multiBlockChecklistRun(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  if (rangeTouchesChecklistItem(state)) {
    return flipTouchedChecklistItems(state, dispatch);
  }
  if (rangeTouchesAnyListItem(state)) {
    return convertTouchedContentToChecklist(state, dispatch);
  }
  return wrapAsChecklist(state, dispatch);
}

/** The flip-all half of `multiBlockChecklistRun` (above) — extracted only for readability, reached exactly when `rangeTouchesChecklistItem` is true. See that function's own comment for the full reasoning (UpNote's own never-un-list behaviour, narrowed by the `isReferencedChecklistItem` guard so a promoted, Task-backed line's own cache is never touched). */
function flipTouchedChecklistItems(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const { from, to } = state.selection;
  let anyBareItem = false;
  let anyBareUnchecked = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (
      node.type === listItemNodeType &&
      node.attrs.checked !== null &&
      !isReferencedChecklistItem(node)
    ) {
      anyBareItem = true;
      if (node.attrs.checked === false) {
        anyBareUnchecked = true;
      }
    }
  });
  if (!anyBareItem) {
    // Every checklist item touched is a promoted, Task-backed reference —
    // nothing here is safe to flip (see this function's own comment).
    return false;
  }
  if (dispatch) {
    const target = anyBareUnchecked;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (
        node.type === listItemNodeType &&
        node.attrs.checked !== null &&
        !isReferencedChecklistItem(node)
      ) {
        tr.setNodeMarkup(pos, undefined, { checked: target });
      }
    });
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * `multiBlockChecklistRun`'s own third case (see its comment above for the
 * live-browser bug this closes): converts every touched top-level plain
 * paragraph AND every touched plain (`checked === null`) `list_item` into a
 * checklist item — the former by wrapping it fresh (one item, `checked:
 * false`, the identical shape `wrapAsChecklist` gives a plain paragraph),
 * the latter with a single `setNodeMarkup`, since it is already sitting
 * inside a list and needs nothing rebuilt around it. A `list_item` nested
 * inside another touched item is walked independently by `nodesBetween`
 * (ProseMirror's own default recursion) and converted too, so selecting an
 * entire nested plain list turns every level of it into a checklist, not
 * only the outermost items.
 *
 * The two kinds of change are applied in two separate passes for exactly
 * one reason: `setNodeMarkup` never changes a node's own size, so every
 * `list_item` position collected from the pristine `state.doc` stays valid
 * throughout, applied in any order — but wrapping a paragraph DOES insert
 * new structure around it, shifting every position after it. Paragraph
 * wraps therefore run LAST-position-first, the identical "process from the
 * end of the document backward" invariant `insertEmSpace`'s own multi-block
 * branch and `liftEveryTouchedTopLevelList` both already rely on, so a
 * still-pending paragraph earlier in the document never has its own
 * position invalidated by a wrap that already ran after it.
 */
function convertTouchedContentToChecklist(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  const { from, to } = state.selection;
  const plainItemPositions: number[] = [];
  const plainParagraphs: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type === listItemNodeType && node.attrs.checked === null) {
      plainItemPositions.push(pos);
    } else if (node.type === paragraphNodeType && parent === state.doc) {
      plainParagraphs.push({ pos, node });
    }
  });
  if (plainItemPositions.length === 0 && plainParagraphs.length === 0) {
    return false;
  }
  if (dispatch) {
    const tr = state.tr;
    for (const pos of plainItemPositions) {
      tr.setNodeMarkup(pos, undefined, { checked: false });
    }
    const byLastPositionFirst = [...plainParagraphs].sort((a, b) => b.pos - a.pos);
    for (const { pos, node } of byLastPositionFirst) {
      const item = listItemNodeType.create({ checked: false }, node);
      const wrapped = bulletListNodeType.create(null, item);
      tr.replaceWith(pos, pos + node.nodeSize, wrapped);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * `checklist`'s own run has three single-item cases, decided by where the
 * caret already is — never a single `wrapInList` call, because "wrap in a
 * checklist" means something different depending on what's already there:
 *
 * - Already a task (`checklistActive`): turn the task OFF, `checked: null`
 *   — the item stays a plain bullet rather than being lifted out of the
 *   list entirely, since unchecking a task is not the same request as
 *   leaving the list. **Refused entirely (issue #235) when that item is a
 *   promoted, `task_reference`-backed line** (`isReferencedChecklistItem`)
 *   — turning it "off" would delete the one attribute that keeps its cache
 *   in sync with a real Task, the identical hazard `multiBlockChecklistRun`
 *   below guards against, reachable here too: a caret placed in the
 *   editable whitespace immediately before or after a re-opened Entry's
 *   reference chip (`taskReferenceNodeView`'s own atom is uneditable, but
 *   the surrounding paragraph it sits in is not) still resolves
 *   `nearestListItem` to that same promoted item.
 * - Already a plain bullet item (inside a list, `checked === null`): the
 *   list wrap this action would otherwise perform already happened: just
 *   add the checkbox, `checked: false`. Never reaches a referenced item —
 *   a `task_reference`-backed item's own `checked` is never `null` — so
 *   this case needs no guard of its own.
 * - Not in any list at all: `wrapAsChecklist` does both steps at once —
 *   wrap in a fresh `bullet_list`, then mark its new items as tasks.
 *
 * A selection spanning more than one block (`selectionSpansMultipleBlocks`,
 * issue #235) is a fourth case, handled entirely by
 * `multiBlockChecklistRun` above instead of the three single-item ones —
 * see that function's own comment for why a multi-block selection never
 * reaches "turn the task off," UpNote's own checklist behaviour having no
 * equivalent to un-list at all.
 */
const checklistRun: Command = (state, dispatch) => {
  if (selectionSpansMultipleBlocks(state)) {
    return multiBlockChecklistRun(state, dispatch);
  }
  if (checklistActive(state)) {
    const item = nearestListItem(state);
    if (item !== null && isReferencedChecklistItem(item)) {
      return false;
    }
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
//
// Issue #233 / ADR 0071 add `sinkFirstListItem` below as a second command
// `indentRun` tries: `sinkListItem` (`prosemirror-schema-list`) refuses the
// FIRST item of a list outright — its own source reads `if (startIndex ==
// 0) return false` — because there is no PRECEDING sibling item for it to
// become a child of. UpNote itself has no such gap
// (`upnote-editor-behaviour.md`'s own Lists table: "Tab on the first item
// of a list | also nests"), because UpNote emits a nested list as a
// SIBLING `<ul>` of the `<li>` it follows, never a child of one — nesting a
// lone item needs no preceding sibling to attach to when the attachment
// point is the list tag itself. `entrySchema`'s `list_item` content is
// `"paragraph block*"` (entry-schema.ts): a nested `bullet_list`/
// `ordered_list` can only ever live INSIDE a `list_item`, never directly
// beside one inside a `bullet_list`/`ordered_list` (whose own content is
// `"list_item+"`), so this schema cannot reproduce UpNote's sibling shape
// at all. `sinkFirstListItem` is the schema-legal equivalent: it wraps the
// first item in a freshly created, otherwise-empty PARENT `list_item` (its
// own leading paragraph has no text, `checked: null`) whose only other
// content is a new nested list holding the original item, now one level
// deeper. That empty parent is rendered markerless in the Composer
// (`index.css`'s own `.ProseMirror li` rules) — ADR 0071's own name for it.
// ---------------------------------------------------------------------------

/**
 * The schema-legal stand-in for UpNote's sibling-`<ul>` nesting (see this
 * section's own module comment above and ADR 0071) — reached only when
 * `sinkListItem` itself already refused, i.e. only for a list item with NO
 * preceding sibling in its own immediate list. Returns `false` unchanged
 * for every other case `sinkListItem` doesn't already cover on its own:
 * a non-empty selection (this command only ever moves a single collapsed
 * caret's own item — the acceptance criteria never asks for a multi-item
 * or multi-block Tab, and ADR 0072 already refuses copying UpNote's own
 * verified multi-block Tab defect), no enclosing `list_item` at all, or an
 * item that DOES have a preceding sibling (nothing for this command to do;
 * `sinkListItem` already handled it, and re-wrapping it again here would
 * double-nest it).
 *
 * The transaction is a single `replaceWith` of the item's own range with
 * the new empty-parent `list_item` — the ORIGINAL item node is reused
 * unchanged as the nested list's only child, not rebuilt, which is what
 * keeps every mark, nested block, and `checked` state it already carried
 * intact. The caret's own new position is computed directly rather than
 * mapped through the transaction's steps: because the original item node
 * is reused byte-for-byte as a descendant of the new parent, ANY position
 * that used to fall within the old item's own range maps to the exact
 * same position plus one fixed offset — the size of everything now
 * inserted AHEAD of it (the parent's own opening token, its empty leading
 * paragraph, and the new nested list's own opening token) — which is
 * computed from the real node sizes below rather than hard-coded, so it
 * stays correct even if `entry-schema.ts`'s own paragraph shape ever
 * changes.
 */
export const sinkFirstListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) {
    return false;
  }
  let itemDepth = -1;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === listItemNodeType) {
      itemDepth = depth;
      break;
    }
  }
  if (itemDepth < 0) {
    return false;
  }
  const listNode = $from.node(itemDepth - 1);
  if (listNode.type !== bulletListNodeType && listNode.type !== orderedListNodeType) {
    return false;
  }
  if ($from.index(itemDepth - 1) !== 0) {
    // Has a preceding sibling — sinkListItem already handles this case.
    return false;
  }
  const itemNode = $from.node(itemDepth);
  const itemStart = $from.before(itemDepth);
  const itemEnd = itemStart + itemNode.nodeSize;

  if (dispatch) {
    const emptyParagraph = paragraphNodeType.create();
    const nestedList = listNode.type.create(null, itemNode);
    const emptyParent = listItemNodeType.create({ checked: null }, [emptyParagraph, nestedList]);
    // Everything inserted ahead of the reused `itemNode`: the parent's own
    // opening token (+1), the empty paragraph in full (`nodeSize`, open +
    // close, no content), and the nested list's own opening token (+1).
    const insertedOffset = 1 + emptyParagraph.nodeSize + 1;
    const tr = state.tr.replaceWith(itemStart, itemEnd, emptyParent);
    const newPos = tr.doc.resolve(Math.min($from.pos + insertedOffset, tr.doc.content.size));
    dispatch(tr.setSelection(TextSelection.near(newPos)).scrollIntoView());
  }
  return true;
};

const indentRun = chainCommands(sinkListItem(listItemNodeType), sinkFirstListItem);
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
// Tab / Shift-Tab outside any list — issue #233, ADR 0070.
// ---------------------------------------------------------------------------

/**
 * Tab with no list to indent: insert a literal U+2003 EM SPACE at the
 * caret and keep focus inside the Composer, rather than letting the
 * keystroke fall through to the browser's own native focus navigation.
 * This is UpNote's own verified behaviour for Tab on plain prose
 * (`upnote-macos-detail.md` Gap sweep Group B6; `upnote-editor-behaviour.md`'s
 * own pre-existing "Tab on plain (non-list) text inserts a literal U+2003
 * EM SPACE" finding) — copied deliberately here, unlike the three UpNote
 * behaviours ADR 0072 refuses to copy, because there is nothing
 * destructive about it. ADR 0070 records why Tab is swallowed
 * UNCONDITIONALLY — never falling through to native focus movement the
 * way this repo's OWN Shift-Tab still can (`outdentEmSpaceOrExit`, right
 * below) — rather than mirroring UpNote's own Tab exactly everywhere: a
 * Composer that let a forward Tab escape would strand a keyboard user
 * inside the Format toolbar and Send button that follow it in tab order,
 * with no equally-unconditional Shift+Tab of its own to back out of the
 * SAME way (`outdentEmSpaceOrExit`'s own comment explains why that one
 * keystroke does still get an exit).
 *
 * **A non-empty selection never has its own text deleted here — issue
 * #235, ADR 0072.** Before this ticket, this function's own
 * `state.tr.insertText(EM_SPACE, from, to)` — the ordinary
 * "replace the range `[from, to)`" shape `insertText` always has —
 * meant pressing Tab across a real selection REPLACED whatever it covered
 * with one em space, silently deleting it. For a selection spanning more
 * than one plain block, that is not hypothetical: it is UpNote's own
 * verified multi-block Tab defect, reproduced 2/2 on both platforms
 * (`upnote-macos-detail.md`/`upnote-android-detail.md` Gap sweep #2 Group
 * K1 — a two-block selection collapses to a single U+2003 em space on
 * macOS, and empties the earlier block outright on Android), and this
 * Composer's own pre-#235 `chainCommands(indent.run, insertEmSpace)`
 * reproduced the IDENTICAL destruction — confirmed directly against this
 * function before this comment was written, not assumed. ADR 0072 already
 * refuses to copy exactly this class of UpNote behaviour ("where UpNote
 * loses content, this Composer diverges on the record rather than copying
 * the loss"), and unlike the three divergences that ADR records as having
 * no code path here to even attempt, THIS one now does — `indent.run`
 * reaches this exact fallback for a real, buildable multi-block
 * plain-prose selection, so the divergence has to be real code, not only a
 * fixture row.
 *
 * The chosen replacement — "indenting every selected block is the
 * obvious reading of intent" — inserts ONE em space at the START of
 * every top-level plain block (a `paragraph` whose own parent is the
 * document root, not a `list_item`) the selection touches, leaving each
 * block's own text completely untouched: two blocks Tab'd together come
 * out as two INDENTED blocks, the multi-block generalisation of what Tab
 * already does to a single block, rather than one block's worth of
 * destroyed text. `list_item`s reached the same way `indent.run`'s own
 * `sinkListItem`/`sinkFirstListItem` already refused are deliberately left
 * alone here — genuinely indenting them is that command's own job, not
 * this fallback's, and this function has no schema-legal way to sink a
 * whole selected RANGE of items that `sinkListItem` itself already
 * declined (most commonly: the range starts at a list's first item, with
 * no preceding sibling for the WHOLE range to nest under —
 * `sinkFirstListItem`'s own guard only ever moves a single collapsed
 * caret's item, never a multi-item range). If the selection touches NO
 * top-level plain block at all — every block it spans is inside a list,
 * and indenting genuinely failed — this still never deletes anything: it
 * falls back to inserting one collapsed em space at the selection's own
 * start, the same single-character insertion a collapsed caret already
 * gets, rather than replacing the range.
 */
export const insertEmSpace: Command = (state, dispatch) => {
  const { $from, empty, from, to } = state.selection;
  if (empty) {
    // The ORIGINAL, pre-#235 guard: a collapsed caret must sit inside an
    // actual textblock to insert a character there at all (a `NodeSelection`
    // on a block-level atom is the one realistic way this fails) — kept
    // scoped to ONLY the collapsed case, unchanged from before this ticket.
    if (!$from.parent.isTextblock) {
      return false;
    }
    if (dispatch) {
      dispatch(state.tr.insertText(" ", from, to).scrollIntoView());
    }
    return true;
  }
  // A non-empty selection — a real dragged/`Shift`-extended `TextSelection`,
  // or Cmd+A/Ctrl+A's own `AllSelection` (verified live, in a real browser,
  // not assumed: `AllSelection`'s own `$from`/`$to` resolve to
  // `doc.resolve(0)`/`doc.resolve(doc.content.size)` — DEPTH 0, genuinely
  // outside any textblock structurally, regardless of what the selection
  // visually covers). Testing `$from.parent.isTextblock` the way the
  // collapsed branch above does would therefore wrongly refuse EVERY
  // `AllSelection` outright — caught live (Cmd+A over plain prose, Tab
  // silently did nothing and would have fallen through to native focus
  // movement, the exact keyboard trap ADR 0070 exists to prevent) — so this
  // branch never reads `$from.parent` at all; it asks the document
  // directly, via touched top-level blocks.
  if (dispatch) {
    const touchedBlockStarts: number[] = [];
    state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (node.type === paragraphNodeType && parent === state.doc) {
        touchedBlockStarts.push(pos + 1);
      }
    });
    if (touchedBlockStarts.length > 0) {
      const tr = state.tr;
      // Insert from the LAST touched block backward: each insertion
      // only shifts positions strictly AFTER itself, so earlier
      // collected positions stay valid without needing to be mapped.
      for (let i = touchedBlockStarts.length - 1; i >= 0; i--) {
        const pos = touchedBlockStarts[i];
        if (pos !== undefined) {
          tr.insertText(" ", pos);
        }
      }
      dispatch(tr.scrollIntoView());
    } else if ($from.parent.isTextblock) {
      // No top-level plain block touched at all (every block the
      // selection spans sits inside a list `indent.run` already refused —
      // this function's own module comment discloses that limit) — still
      // never destroy anything: a single collapsed em space at the
      // selection's own start, exactly like the collapsed-caret case
      // above, ONLY when that position is itself genuinely insertable.
      dispatch(state.tr.insertText(" ", from, from).scrollIntoView());
    }
    // Neither branch had anywhere valid to insert into (e.g. a full-
    // document `AllSelection` whose own position 0 sits at the very start
    // of a list, not a paragraph) — nothing is dispatched, but this still
    // returns `true` below: ADR 0070's own "Tab is swallowed
    // unconditionally" holds regardless of whether there was anything
    // visible left to do, since the alternative — falling through to
    // native focus movement here — is exactly the keyboard trap that ADR
    // exists to prevent.
  }
  return true;
};

/**
 * Shift-Tab with no list to outdent: delete ONE preceding U+2003 EM SPACE
 * if the caret sits immediately after one — undoing exactly what
 * `insertEmSpace` above just inserted — and otherwise return `false`,
 * letting focus move BACKWARD out of the Composer. ADR 0070 names this the
 * one deliberate divergence from copying UpNote exactly: UpNote's own
 * Shift+Tab on plain prose is a pure content no-op that never moves focus
 * either (`upnote-macos-detail.md` Gap sweep Group B3), because UpNote is
 * never downstream of anything else a keyboard user might need to tab
 * onward to. This Composer sits ahead of a Format toolbar and a Send
 * button, and Tab (above) is swallowed unconditionally — so without SOME
 * way out, a reader who tabs INTO the field and never touches a list at
 * all would have no keyboard path back to the rest of the page. Shift-Tab
 * in bare prose with nothing to undo is that path: the one gesture this
 * repo lets fall through to the browser's own native backward focus
 * navigation, confined to exactly the case UpNote itself already treats as
 * a no-op, so nothing this repo's own document ever needed to keep is at
 * stake either way.
 */
export const outdentEmSpaceOrExit: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) {
    return false;
  }
  const nodeBefore = $from.nodeBefore;
  if (nodeBefore === null || !nodeBefore.isText || !(nodeBefore.text ?? "").endsWith(" ")) {
    return false;
  }
  if (dispatch) {
    dispatch(state.tr.delete($from.pos - 1, $from.pos).scrollIntoView());
  }
  return true;
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
