/**
 * Direct unit coverage for the Composer's named editing actions (issue
 * #160) — every action's `isActive`/`isEnabled`/`run` exercised against a
 * plain `EditorState` built straight off `entrySchema` (via
 * `entryMarkdownToDocument`, entry-document.ts — the same conversion the
 * real Composer seeds its own document from), with a bare function
 * standing in for `dispatch`. No `EditorView` anywhere: jsdom cannot mount
 * one at all (ADR 0044), and composer-commands.ts's own module comment is
 * explicit that none of its commands should ever need one — if a test here
 * needed a live view, that would itself be a bug in the module, not a gap
 * in the test.
 *
 * `findMarkRange`/`findNodePos` below locate positions by walking the built
 * document rather than hardcoding numeric offsets — the exact positions
 * `entryMarkdownToDocument` produces for a given string are an
 * implementation detail of `blocksToPM`/`inlineNodesToPM`, not something
 * this file should have to keep in sync with by hand.
 */
import { chainCommands } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
} from "prosemirror-state";
import { describe, expect, it } from "vitest";
import {
  bold,
  bulletList,
  checklist,
  code,
  composerCommands,
  indent,
  insertEmSpace,
  italic,
  orderedList,
  outdent,
  outdentEmSpaceOrExit,
  redoCommand,
  reference,
  sinkFirstListItem,
  softBreak,
  splitListItemUnchecked,
  strikethrough,
  toggleCheckboxDone,
  undoCommand,
} from "./composer-commands";
import { entryMarkdownToDocument } from "./entry-document";
import { entrySchema } from "./entry-schema";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function docFor(body: string): PMNode {
  return entryMarkdownToDocument(body);
}

/** An `EditorState` with the caret/selection placed explicitly, rather than left at `Selection.atEnd`'s default — most of the commands here care exactly where the selection is. */
function stateAt(
  doc: PMNode,
  selection: { from: number; to?: number },
  withHistory = false,
): EditorState {
  return EditorState.create({
    schema: entrySchema,
    doc,
    selection: TextSelection.create(doc, selection.from, selection.to ?? selection.from),
    plugins: withHistory ? [history()] : [],
  });
}

/**
 * An `EditorState` whose selection spans the ENTIRE document — the
 * multi-block tests below (issue #235) all start from the same "Cmd+A,
 * then run the chord" shape the gap-sweep docs themselves use. Built with
 * `Selection.atStart`/`Selection.atEnd` rather than `TextSelection.create(doc,
 * 0, doc.content.size)`: a raw `0`/`content.size` pair is only valid when
 * the doc's OUTERMOST content is itself a textblock, and every multi-block
 * fixture below wraps its content in `bullet_list`/`ordered_list` nodes at
 * some point in its own round trip — `Selection.atStart`/`atEnd` are
 * `prosemirror-state`'s own documented way to find the nearest valid
 * selectable position instead, regardless of what sits at the top.
 */
function selectAllState(doc: PMNode): EditorState {
  const from = Selection.atStart(doc).from;
  const to = Selection.atEnd(doc).to;
  return EditorState.create({
    schema: entrySchema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

/**
 * An `EditorState` whose selection is a REAL `AllSelection` — what a
 * genuine Cmd+A/Ctrl+A keypress actually produces in the live Composer
 * (`prosemirror-commands`' own `selectAll`), NOT a `TextSelection` that
 * merely happens to span the whole document the way `selectAllState` above
 * builds. The distinction is load-bearing, found live against a real
 * browser, not assumed: an `AllSelection`'s own `$from`/`$to` resolve to
 * `doc.resolve(0)`/`doc.resolve(doc.content.size)` — DEPTH 0, genuinely
 * outside any textblock or list structurally — which broke this module's
 * OWN single-item ancestor-walking checks (`hasListAncestor`,
 * `nearestListItem`) in a way `selectAllState`'s `TextSelection` never
 * could, since THAT selection's `$from` still resolves to a normal,
 * depth-appropriate position inside the first textblock. Every fixture
 * below that specifically exercises the `AllSelection` branches
 * (`selectionSpansMultipleBlocks`'s own `instanceof AllSelection` check,
 * and `bulletListActive`/`orderedListActive`/`checklistActive`'s matching
 * guards) uses THIS helper, not `selectAllState` — the two are not
 * interchangeable, and a fixture that silently used the wrong one would
 * pass without ever having tested the real gesture at all.
 */
function realAllSelectionState(doc: PMNode): EditorState {
  return EditorState.create({
    schema: entrySchema,
    doc,
    selection: new AllSelection(doc),
  });
}

/** Node-type constants for the multi-block fixtures below (issue #235) — a non-null accessor, matching composer-commands.ts's own `requireNodeType` pattern, rather than the bare `entrySchema.nodes.x?.create(...)` optional-chaining `emptyCheckedItemDoc` (above) uses: these are reused across many fixtures below, so one throw-on-typo lookup each beats re-deciding how to handle `undefined` at every call site. */
function requireNodeType(name: string) {
  const type = entrySchema.nodes[name];
  if (type === undefined) {
    throw new Error(`entrySchema has no "${name}" node type`);
  }
  return type;
}

const bulletListNodeType = requireNodeType("bullet_list");
const orderedListNodeType = requireNodeType("ordered_list");
const listItemNodeType = requireNodeType("list_item");
const paragraphNodeType = requireNodeType("paragraph");
const taskReferenceNodeType = requireNodeType("task_reference");

/** A plain top-level `paragraph` node, the schema-level building block every "N plain blocks" fixture below is made of — built directly rather than through `entryMarkdownToDocument`, since typing Enter in the live Composer today is a soft break everywhere (issue #234, not yet shipped — ADR 0069's own Status section), so N separate top-level blocks currently have no Markdown source string this helper could round-trip through either. */
function paragraph(text: string): PMNode {
  return paragraphNodeType.create(null, text.length > 0 ? [entrySchema.text(text)] : []);
}

/** A `list_item` node — `checked: null` for a plain bullet, `true`/`false` for a task — used by the nested-list and checklist-safety fixtures below to build shapes `entryMarkdownToDocument` cannot produce directly (a multi-level nested list, or a `task_reference`-bearing item with no real Task behind it in this test). */
function listItem(checked: boolean | null, ...content: PMNode[]): PMNode {
  return listItemNodeType.create({ checked }, content);
}

/** A `task_reference` atom — Promotion's own output shape (ADR 0048) — standing in for a real Task without needing a live `EntryStore`; only its NODE TYPE matters to `multiBlockChecklistRun`'s own safety guard, never its actual attrs. */
function taskReference(taskId: string, label: string, checked: boolean): PMNode {
  return taskReferenceNodeType.create({ taskId, label, checked });
}

/** The `[from, to)` range of the first text run carrying `markName` — `strong`/`em`/`code` never appear more than once per test fixture below. */
function findMarkRange(doc: PMNode, markName: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (range === null && node.isText && node.marks.some((mark) => mark.type.name === markName)) {
      range = { from: pos, to: pos + node.nodeSize };
    }
  });
  if (range === null) {
    throw new Error(`fixture has no "${markName}" mark run`);
  }
  return range;
}

/** The position immediately before the first node of type `nodeName`. */
function findNodePos(doc: PMNode, nodeName: string): number {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found === null && node.type.name === nodeName) {
      found = pos;
    }
  });
  if (found === null) {
    throw new Error(`fixture has no "${nodeName}" node`);
  }
  return found;
}

/** A position inside the first `paragraph` found anywhere in `doc` — good enough as "somewhere a caret could sit" for fixtures whose exact text doesn't matter to the assertion. */
function caretInFirstParagraph(doc: PMNode): number {
  return findNodePos(doc, "paragraph") + 1;
}

/** A position inside the Nth (1-indexed) `paragraph` found anywhere in `doc`, in document order — used by the indent/outdent fixtures below to reach the SECOND list item's own paragraph rather than the first. */
function caretInNthParagraph(doc: PMNode, n: number): number {
  let seen = 0;
  let result: number | undefined;
  doc.descendants((node, pos) => {
    if (node.type.name === "paragraph") {
      seen += 1;
      if (seen === n) {
        result = pos + 1;
      }
    }
  });
  if (result === undefined) {
    throw new Error(`fixture has no ${n}th paragraph`);
  }
  return result;
}

/** Every position of type `nodeName` in `doc`, document order — used below where a fixture needs the SECOND (or later) `list_item` a split just created, not just the first `findNodePos` returns. */
function findNodePositions(doc: PMNode, nodeName: string): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === nodeName) {
      positions.push(pos);
    }
  });
  return positions;
}

/** The (0-indexed) `n`th position of type `nodeName` in `doc` — `findNodePositions` plus a bounds check, so callers get a plain `number` under `noUncheckedIndexedAccess` instead of `number | undefined`. */
function nthNodePos(doc: PMNode, nodeName: string, n: number): number {
  const pos = findNodePositions(doc, nodeName)[n];
  if (pos === undefined) {
    throw new Error(`fixture has no "${nodeName}" #${n}`);
  }
  return pos;
}

function countNodesOfType(doc: PMNode, nodeName: string): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === nodeName) {
      count += 1;
    }
  });
  return count;
}

/** Runs `command.run` with a `dispatch` that captures the transaction rather than a live `EditorView`, and returns both the boolean result and the resulting state (only meaningful when `applied` is `true`). */
function runCommand(
  command: { run: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean },
  state: EditorState,
): { applied: boolean; next: EditorState } {
  let captured: Transaction | null = null;
  const applied = command.run(state, (tr) => {
    captured = tr;
  });
  return { applied, next: captured === null ? state : state.apply(captured) };
}

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

describe("composerCommands", () => {
  it("lists exactly the thirteen actions the ticket requires, each with a unique id", () => {
    const ids = composerCommands.map((command) => command.id);
    expect(ids).toEqual([
      "bold",
      "italic",
      "strikethrough",
      "code",
      "bulletList",
      "orderedList",
      "checklist",
      "indent",
      "outdent",
      "reference",
      "softBreak",
      "undo",
      "redo",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Marks: bold, italic, code
// ---------------------------------------------------------------------------

describe.each([
  { command: bold, id: "bold", markName: "strong", markdown: "before **bold** after" },
  { command: italic, id: "italic", markName: "em", markdown: "before *italic* after" },
  {
    command: strikethrough,
    id: "strikethrough",
    markName: "strikethrough",
    markdown: "before ~~struck~~ after",
  },
  { command: code, id: "code", markName: "code", markdown: "before `code` after" },
])("$id", ({ command, markName, markdown }) => {
  it("is active when the whole selection carries the mark, inactive otherwise", () => {
    const doc = docFor(markdown);
    const { from, to } = findMarkRange(doc, markName);
    expect(command.isActive(stateAt(doc, { from, to }))).toBe(true);
    // Selecting "before " — plain text with none of this mark.
    expect(command.isActive(stateAt(doc, { from: 1, to: from }))).toBe(false);
  });

  it("is enabled on an ordinary text selection", () => {
    const doc = docFor(markdown);
    const { from, to } = findMarkRange(doc, markName);
    expect(command.isEnabled(stateAt(doc, { from, to }))).toBe(true);
  });

  it("is enabled even on a NodeSelection covering a Reference atom", () => {
    // `toggleMark`'s own default (`enterInlineAtoms`, prosemirror-commands)
    // is to allow marking an atom node's full span, not to refuse it — a
    // bolded Reference is an unusual thing to write, but nothing in this
    // schema (entry-schema.ts has no `marks` restriction on `reference`)
    // forbids it, so this asserts the permissive default rather than a
    // refusal this schema never actually models.
    const doc = docFor("[[2026-08-28]]");
    const pos = findNodePos(doc, "reference");
    const state = EditorState.create({
      schema: entrySchema,
      doc,
      selection: NodeSelection.create(doc, pos),
    });
    expect(command.isEnabled(state)).toBe(true);
  });

  it("toggles the mark on, then off again, on run", () => {
    const doc = docFor("plain text");
    const state = stateAt(doc, { from: 1, to: 6 }); // "plain"
    expect(command.isActive(state)).toBe(false);

    const on = runCommand(command, state);
    expect(on.applied).toBe(true);
    expect(command.isActive(stateAt(on.next.doc, { from: 1, to: 6 }))).toBe(true);

    const onState = stateAt(on.next.doc, { from: 1, to: 6 });
    const off = runCommand(command, onState);
    expect(off.applied).toBe(true);
    expect(command.isActive(stateAt(off.next.doc, { from: 1, to: 6 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bulletList / orderedList
// ---------------------------------------------------------------------------

describe("bulletList", () => {
  it("is active inside a plain bullet item, inactive inside a checklist item or plain text", () => {
    expect(
      bulletList.isActive(
        stateAt(docFor("- item"), { from: caretInFirstParagraph(docFor("- item")) }),
      ),
    ).toBe(true);
    const checklistDoc = docFor("- [ ] item");
    expect(
      bulletList.isActive(stateAt(checklistDoc, { from: caretInFirstParagraph(checklistDoc) })),
    ).toBe(false);
    const plainDoc = docFor("just text");
    expect(bulletList.isActive(stateAt(plainDoc, { from: caretInFirstParagraph(plainDoc) }))).toBe(
      false,
    );
  });

  it("wraps a plain paragraph in a bullet_list with checked left null, then lifts back out", () => {
    const doc = docFor("buy milk");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(bulletList.isEnabled(state)).toBe(true);

    const wrapped = runCommand(bulletList, state);
    expect(wrapped.applied).toBe(true);
    expect(countNodesOfType(wrapped.next.doc, "bullet_list")).toBe(1);
    const itemPos = findNodePos(wrapped.next.doc, "list_item");
    const item = wrapped.next.doc.nodeAt(itemPos);
    expect(item?.attrs.checked).toBeNull();

    const wrappedState = stateAt(wrapped.next.doc, {
      from: caretInFirstParagraph(wrapped.next.doc),
    });
    expect(bulletList.isActive(wrappedState)).toBe(true);
    expect(bulletList.isEnabled(wrappedState)).toBe(true);

    const lifted = runCommand(bulletList, wrappedState);
    expect(lifted.applied).toBe(true);
    expect(countNodesOfType(lifted.next.doc, "bullet_list")).toBe(0);
  });
});

describe("orderedList", () => {
  it("is active inside an ordered list, inactive elsewhere", () => {
    const orderedDoc = docFor("1. first\n2. second");
    expect(
      orderedList.isActive(stateAt(orderedDoc, { from: caretInFirstParagraph(orderedDoc) })),
    ).toBe(true);
    const plainDoc = docFor("just text");
    expect(orderedList.isActive(stateAt(plainDoc, { from: caretInFirstParagraph(plainDoc) }))).toBe(
      false,
    );
  });

  it("wraps a plain paragraph in an ordered_list with checked left null", () => {
    const doc = docFor("buy milk");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(orderedList.isEnabled(state)).toBe(true);

    const wrapped = runCommand(orderedList, state);
    expect(wrapped.applied).toBe(true);
    const itemPos = findNodePos(wrapped.next.doc, "list_item");
    expect(wrapped.next.doc.nodeAt(itemPos)?.attrs.checked).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checklist
// ---------------------------------------------------------------------------

describe("checklist", () => {
  it("is active only when the enclosing list_item is a task (checked !== null)", () => {
    const uncheckedDoc = docFor("- [ ] item");
    expect(
      checklist.isActive(stateAt(uncheckedDoc, { from: caretInFirstParagraph(uncheckedDoc) })),
    ).toBe(true);
    const checkedDoc = docFor("- [x] item");
    expect(
      checklist.isActive(stateAt(checkedDoc, { from: caretInFirstParagraph(checkedDoc) })),
    ).toBe(true);
    const plainBulletDoc = docFor("- item");
    expect(
      checklist.isActive(stateAt(plainBulletDoc, { from: caretInFirstParagraph(plainBulletDoc) })),
    ).toBe(false);
    const plainDoc = docFor("just text");
    expect(checklist.isActive(stateAt(plainDoc, { from: caretInFirstParagraph(plainDoc) }))).toBe(
      false,
    );
  });

  it("wraps a plain paragraph in a bullet_list and sets checked: false on the new item", () => {
    const doc = docFor("buy milk");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(checklist.isEnabled(state)).toBe(true);

    const { applied, next } = runCommand(checklist, state);
    expect(applied).toBe(true);
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(1);
    const itemPos = findNodePos(next.doc, "list_item");
    expect(next.doc.nodeAt(itemPos)?.attrs.checked).toBe(false);
  });

  it("adds a checkbox to an already-wrapped plain bullet item without re-wrapping it", () => {
    const doc = docFor("- item");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });

    const { applied, next } = runCommand(checklist, state);
    expect(applied).toBe(true);
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(1);
    const itemPos = findNodePos(next.doc, "list_item");
    expect(next.doc.nodeAt(itemPos)?.attrs.checked).toBe(false);
  });

  it("turns an existing task back into a plain bullet item (checked: null), whether it was checked or not", () => {
    for (const markdown of ["- [ ] item", "- [x] item"]) {
      const doc = docFor(markdown);
      const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
      expect(checklist.isActive(state)).toBe(true);

      const { applied, next } = runCommand(checklist, state);
      expect(applied).toBe(true);
      const itemPos = findNodePos(next.doc, "list_item");
      expect(next.doc.nodeAt(itemPos)?.attrs.checked).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// indent / outdent
// ---------------------------------------------------------------------------

describe("indent", () => {
  it("is never reported active — it is a one-shot action, not a toggle state", () => {
    const indentDoc = docFor("- item");
    expect(indent.isActive(stateAt(indentDoc, { from: caretInFirstParagraph(indentDoc) }))).toBe(
      false,
    );
  });

  it("is enabled both on a list item with a preceding sibling AND on the first item — issue #233 adds sinkFirstListItem as indent.run's own second fallback", () => {
    const doc = docFor("- first\n- second");
    const firstParaPos = caretInFirstParagraph(doc);
    // The first item has no PRECEDING sibling for plain sinkListItem to
    // sink it under, but it DOES have a following one for
    // sinkFirstListItem to wrap into an empty parent — see that command's
    // own describe block below for the resulting shape.
    expect(indent.isEnabled(stateAt(doc, { from: firstParaPos }))).toBe(true);

    // The second item's own paragraph — plain sinkListItem already
    // handles this case; sinkFirstListItem never even runs for it.
    expect(indent.isEnabled(stateAt(doc, { from: caretInNthParagraph(doc, 2) }))).toBe(true);
  });

  it("is disabled outside any list — neither sinkListItem nor sinkFirstListItem has anything to sink", () => {
    const doc = docFor("just text");
    expect(indent.isEnabled(stateAt(doc, { from: caretInFirstParagraph(doc) }))).toBe(false);
  });

  it("sinks the item under its preceding sibling on run", () => {
    const doc = docFor("- first\n- second");
    const state = stateAt(doc, { from: caretInNthParagraph(doc, 2) });
    expect(countNodesOfType(doc, "bullet_list")).toBe(1);

    const { applied, next } = runCommand(indent, state);
    expect(applied).toBe(true);
    // Sinking "second" under "first" creates a nested bullet_list inside
    // "first"'s own list_item — two bullet_lists total where there was one.
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(2);
  });

  it("wraps a first item with no preceding sibling under a new empty markerless parent on run — sinkFirstListItem's own fallback", () => {
    const doc = docFor("- first\n- second");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });

    const { applied, next } = runCommand(indent, state);
    expect(applied).toBe(true);
    // "first" nests under a brand-new empty parent item; "second" stays a
    // top-level sibling of that parent, untouched — three list_items total
    // (empty parent, first, second) where there were two, two bullet_lists
    // (the original outer one, plus the new nested one) where there was
    // one.
    expect(countNodesOfType(next.doc, "list_item")).toBe(3);
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(2);
    const outerItems = next.doc.firstChild;
    if (outerItems === null || outerItems.type.name !== "bullet_list") {
      throw new Error("expected the outer bullet_list to survive");
    }
    const emptyParent = outerItems.firstChild;
    if (emptyParent === null) {
      throw new Error("expected an empty parent list_item");
    }
    expect(emptyParent.type.name).toBe("list_item");
    expect(emptyParent.attrs.checked).toBeNull();
    expect(emptyParent.childCount).toBe(2);
    expect(emptyParent.child(0).type.name).toBe("paragraph");
    expect(emptyParent.child(0).content.size).toBe(0);
    expect(emptyParent.child(1).type.name).toBe("bullet_list");
    expect(emptyParent.child(1).firstChild?.textContent).toBe("first");
    expect(outerItems.child(1).textContent).toBe("second");
  });
});

describe("outdent", () => {
  it("is never reported active", () => {
    const outdentDoc = docFor("- item");
    expect(outdent.isActive(stateAt(outdentDoc, { from: caretInFirstParagraph(outdentDoc) }))).toBe(
      false,
    );
  });

  it("is disabled outside any list, enabled inside one", () => {
    const plainDoc = docFor("just text");
    expect(outdent.isEnabled(stateAt(plainDoc, { from: caretInFirstParagraph(plainDoc) }))).toBe(
      false,
    );

    const listDoc = docFor("- item");
    expect(outdent.isEnabled(stateAt(listDoc, { from: caretInFirstParagraph(listDoc) }))).toBe(
      true,
    );
  });

  it("lifts the item out of its list on run", () => {
    const doc = docFor("- item");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(countNodesOfType(doc, "bullet_list")).toBe(1);

    const { applied, next } = runCommand(outdent, state);
    expect(applied).toBe(true);
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(0);
    expect(countNodesOfType(next.doc, "list_item")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sinkFirstListItem — issue #233 / ADR 0071, indent.run's own second
// fallback for the one case plain sinkListItem always refuses.
// ---------------------------------------------------------------------------

describe("sinkFirstListItem", () => {
  it("returns false outside any list — nothing to sink", () => {
    const doc = docFor("just text");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(sinkFirstListItem(state)).toBe(false);
  });

  it("returns false on an item WITH a preceding sibling — plain sinkListItem already owns that case", () => {
    const doc = docFor("- first\n- second");
    const state = stateAt(doc, { from: caretInNthParagraph(doc, 2) });
    expect(sinkFirstListItem(state)).toBe(false);
  });

  it("wraps a truly LONE item (no siblings at all) under a new empty markerless parent", () => {
    const doc = docFor("- solo");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(countNodesOfType(doc, "list_item")).toBe(1);

    const { applied, next } = runCommand({ run: sinkFirstListItem }, state);
    expect(applied).toBe(true);
    expect(countNodesOfType(next.doc, "list_item")).toBe(2);
    expect(countNodesOfType(next.doc, "bullet_list")).toBe(2);

    const outerList = next.doc.firstChild;
    if (outerList === null || outerList.type.name !== "bullet_list") {
      throw new Error("expected the outer bullet_list to survive");
    }
    expect(outerList.childCount).toBe(1);
    const emptyParent = outerList.firstChild;
    if (emptyParent === null) {
      throw new Error("expected an empty parent list_item");
    }
    expect(emptyParent.attrs.checked).toBeNull();
    expect(emptyParent.child(0).content.size).toBe(0);
    expect(emptyParent.child(1).type.name).toBe("bullet_list");
    expect(emptyParent.child(1).firstChild?.textContent).toBe("solo");
  });

  it("preserves an ordered list's own type in the newly nested list", () => {
    const doc = docFor("1. solo");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });

    const { applied, next } = runCommand({ run: sinkFirstListItem }, state);
    expect(applied).toBe(true);
    const outerList = next.doc.firstChild;
    if (outerList === null) {
      throw new Error("expected an outer list");
    }
    expect(outerList.type.name).toBe("ordered_list");
    const nested = outerList.firstChild?.child(1);
    expect(nested?.type.name).toBe("ordered_list");
  });

  it("lands the caret back inside the sunk item's own text, not at the new parent's empty paragraph", () => {
    const doc = docFor("- solo");
    const original = caretInFirstParagraph(doc) + "solo".length; // end of "solo"
    const state = stateAt(doc, { from: original });

    const { applied, next } = runCommand({ run: sinkFirstListItem }, state);
    expect(applied).toBe(true);
    const $sel = next.selection.$from;
    expect($sel.parent.type.name).toBe("paragraph");
    expect($sel.parent.textContent).toBe("solo");
  });

  it("supports a dry run with no dispatch", () => {
    const doc = docFor("- solo");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(sinkFirstListItem(state)).toBe(true);
    expect(countNodesOfType(state.doc, "list_item")).toBe(1); // untouched
  });

  it("returns false on a non-empty selection", () => {
    const doc = docFor("- solo");
    const start = caretInFirstParagraph(doc);
    const state = stateAt(doc, { from: start, to: start + 2 });
    expect(sinkFirstListItem(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// insertEmSpace / outdentEmSpaceOrExit — Tab/Shift-Tab outside any list,
// issue #233 / ADR 0070.
// ---------------------------------------------------------------------------

describe("insertEmSpace", () => {
  it("inserts a literal U+2003 EM SPACE at the caret and keeps returning true (never a native focus move)", () => {
    const doc = docFor("abcd");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) + 2 }); // between "ab" and "cd"

    const { applied, next } = runCommand({ run: insertEmSpace }, state);
    expect(applied).toBe(true);
    expect(next.doc.textContent).toBe("ab cd");
  });

  it("supports a dry run with no dispatch", () => {
    const doc = docFor("abcd");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(insertEmSpace(state)).toBe(true);
    expect(state.doc.textContent).toBe("abcd"); // untouched
  });
});

describe("outdentEmSpaceOrExit", () => {
  it("deletes exactly one preceding U+2003 EM SPACE and reports handled", () => {
    const doc = docFor("ab cd");
    const pos = caretInFirstParagraph(doc) + "ab ".length;
    const state = stateAt(doc, { from: pos });

    const { applied, next } = runCommand({ run: outdentEmSpaceOrExit }, state);
    expect(applied).toBe(true);
    expect(next.doc.textContent).toBe("abcd");
  });

  it("returns false with nothing to undo — a bare-prose caret with no preceding em space — letting focus move backward", () => {
    const doc = docFor("plain text here");
    const state = stateAt(doc, {
      from: caretInFirstParagraph(doc) + "plain text here".length,
    });
    expect(outdentEmSpaceOrExit(state)).toBe(false);
  });

  it("returns false at the very start of a block — nothing precedes the caret at all", () => {
    const doc = docFor("abcd");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(outdentEmSpaceOrExit(state)).toBe(false);
  });

  it("returns false when the preceding character is an ordinary space, not an em space", () => {
    const doc = docFor("ab cd");
    const pos = caretInFirstParagraph(doc) + "ab ".length;
    const state = stateAt(doc, { from: pos });
    expect(outdentEmSpaceOrExit(state)).toBe(false);
  });

  it("returns false on a non-empty selection", () => {
    const doc = docFor("ab cd");
    const from = caretInFirstParagraph(doc) + "ab ".length;
    const state = stateAt(doc, { from, to: from + 1 });
    expect(outdentEmSpaceOrExit(state)).toBe(false);
  });

  it("supports a dry run with no dispatch", () => {
    const doc = docFor("ab cd");
    const pos = caretInFirstParagraph(doc) + "ab ".length;
    const state = stateAt(doc, { from: pos });
    expect(outdentEmSpaceOrExit(state)).toBe(true);
    expect(state.doc.textContent).toBe("ab cd"); // untouched
  });
});

// ---------------------------------------------------------------------------
// reference
// ---------------------------------------------------------------------------

describe("reference", () => {
  it("is never reported active — it inserts a trigger, it doesn't toggle a state", () => {
    expect(reference.isActive(stateAt(docFor("hello"), { from: 1 }))).toBe(false);
  });

  it("is enabled in an ordinary textblock", () => {
    expect(reference.isEnabled(stateAt(docFor("hello"), { from: 1 }))).toBe(true);
  });

  it("inserts the `[[` picker trigger at the caret on run", () => {
    const doc = docFor("hello");
    // Caret between "he" and "llo".
    const state = stateAt(doc, { from: 3 });

    const { applied, next } = runCommand(reference, state);
    expect(applied).toBe(true);
    expect(next.doc.textBetween(0, next.doc.content.size)).toBe("he[[llo");
  });
});

// ---------------------------------------------------------------------------
// softBreak / insertSoftBreak — issue #212
// ---------------------------------------------------------------------------

/** The position right after a document's first (and only) top-level paragraph's own content — mirrors composer-editor.test.ts's identical helper, duplicated here for the reason `stateAt` above already documents about the two files. */
function endOfFirstParagraph(doc: PMNode): number {
  const first = doc.firstChild;
  if (first === null || first.type.name !== "paragraph") {
    throw new Error("fixture has no leading paragraph");
  }
  return 1 + first.content.size;
}

describe("softBreak", () => {
  it("is never reported active — inserting a break has no pressed state to report", () => {
    expect(softBreak.isActive(stateAt(docFor("hello"), { from: 1 }))).toBe(false);
  });

  it("is enabled in an ordinary textblock", () => {
    expect(softBreak.isEnabled(stateAt(docFor("hello"), { from: 1 }))).toBe(true);
  });

  it("is disabled (and a no-op on run) outside a textblock — a NodeSelection on a block node", () => {
    const doc = docFor("- milk");
    const pos = findNodePos(doc, "bullet_list");
    const state = EditorState.create({
      schema: entrySchema,
      doc,
      selection: NodeSelection.create(doc, pos),
    });
    expect(softBreak.isEnabled(state)).toBe(false);
    expect(runCommand(softBreak, state).applied).toBe(false);
  });

  it("inserts a literal newline at the caret, in place — never a new paragraph", () => {
    const doc = docFor("hello");
    const state = stateAt(doc, { from: 3 }); // caret between "he" and "llo"
    const { applied, next } = runCommand(softBreak, state);
    expect(applied).toBe(true);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild?.type.name).toBe("paragraph");
    expect(next.doc.textBetween(0, next.doc.content.size)).toBe("he\nllo");
  });

  it("two soft breaks in a row give a genuine blank line — the ticket's own acceptance bar", () => {
    const doc = docFor("hello");
    const once = runCommand(softBreak, stateAt(doc, { from: 3 }));
    const twice = runCommand(softBreak, stateAt(once.next.doc, { from: 4 }));
    expect(twice.applied).toBe(true);
    expect(twice.next.doc.textBetween(0, twice.next.doc.content.size)).toBe("he\n\nllo");
  });

  it("inherits an active mark (strong) onto the inserted newline, like any other typed character", () => {
    const strongMarkType = entrySchema.marks.strong;
    if (strongMarkType === undefined) {
      throw new Error("entrySchema has no strong mark");
    }
    const doc = entrySchema.node("doc", null, [
      entrySchema.node("paragraph", null, entrySchema.text("bold", [strongMarkType.create()])),
    ]);
    const insertAt = endOfFirstParagraph(doc);
    const state = stateAt(doc, { from: insertAt });
    const { applied, next } = runCommand(softBreak, state);
    expect(applied).toBe(true);
    expect(next.doc.textBetween(1, next.doc.content.size - 1)).toBe("bold\n");
    // `rangeHasMark`, not a search for a standalone "\n" text node: the
    // inserted character shares the SAME mark set as the "bold" text run it
    // was appended to, so ProseMirror's own `Fragment` joins the two into
    // ONE text node ("bold\n") rather than leaving two adjacent nodes with
    // identical marks — checking the mark over the newline's own position
    // range is what stays correct regardless of that joining.
    expect(next.doc.rangeHasMark(insertAt, insertAt + 1, strongMarkType)).toBe(true);
  });

  it("strips the code mark from the inserted newline, but keeps every other inherited mark", () => {
    const codeMarkType = entrySchema.marks.code;
    const strongMarkType = entrySchema.marks.strong;
    if (codeMarkType === undefined || strongMarkType === undefined) {
      throw new Error("entrySchema is missing a mark type this test needs");
    }
    const doc = entrySchema.node("doc", null, [
      entrySchema.node("paragraph", null, [
        entrySchema.text("snippet", [codeMarkType.create(), strongMarkType.create()]),
      ]),
    ]);
    const state = stateAt(doc, { from: endOfFirstParagraph(doc) });
    const { applied, next } = runCommand(softBreak, state);
    expect(applied).toBe(true);
    let newlineMarkNames: string[] = [];
    next.doc.descendants((node) => {
      if (node.isText && node.text === "\n") {
        newlineMarkNames = node.marks.map((mark) => mark.type.name);
      }
    });
    expect(newlineMarkNames).toContain("strong");
    expect(newlineMarkNames).not.toContain("code");
  });
});

// ---------------------------------------------------------------------------
// undo / redo
// ---------------------------------------------------------------------------

describe("undo / redo", () => {
  it("are never reported active", () => {
    const state = stateAt(docFor("hello"), { from: 1 }, true);
    expect(undoCommand.isActive(state)).toBe(false);
    expect(redoCommand.isActive(state)).toBe(false);
  });

  it("start disabled on a fresh history, and undoCommand.run/redoCommand.run are the library's own undo/redo", () => {
    expect(undoCommand.run).toBe(undo);
    expect(redoCommand.run).toBe(redo);

    const fresh = stateAt(docFor("hello"), { from: 1 }, true);
    expect(undoCommand.isEnabled(fresh)).toBe(false);
    expect(redoCommand.isEnabled(fresh)).toBe(false);
  });

  it("becomes enabled after an edit, reverts it on run, and redo brings it back", () => {
    const doc = docFor("hello");
    const state = stateAt(doc, { from: 1 }, true);

    const edited = state.apply(state.tr.insertText("!", state.doc.content.size - 1));
    expect(edited.doc.textBetween(0, edited.doc.content.size)).toBe("hello!");
    expect(undoCommand.isEnabled(edited)).toBe(true);
    expect(redoCommand.isEnabled(edited)).toBe(false);

    const undone = runCommand(undoCommand, edited);
    expect(undone.applied).toBe(true);
    expect(undone.next.doc.textBetween(0, undone.next.doc.content.size)).toBe("hello");
    expect(redoCommand.isEnabled(undone.next)).toBe(true);

    const redone = runCommand(redoCommand, undone.next);
    expect(redone.applied).toBe(true);
    expect(redone.next.doc.textBetween(0, redone.next.doc.content.size)).toBe("hello!");
  });
});

// ---------------------------------------------------------------------------
// toggleCheckboxDone — issue #164's Mod-Shift-Enter, not one of the twelve
// toolbar buttons (see this command's own doc comment for why).
// ---------------------------------------------------------------------------

describe("toggleCheckboxDone", () => {
  it("is disabled, and a no-op on run, outside any task item — a plain bullet or plain text", () => {
    const bulletDoc = docFor("- item");
    const bulletState = stateAt(bulletDoc, { from: caretInFirstParagraph(bulletDoc) });
    expect(toggleCheckboxDone.isEnabled(bulletState)).toBe(false);
    expect(runCommand(toggleCheckboxDone, bulletState).applied).toBe(false);

    const plainDoc = docFor("just text");
    const plainState = stateAt(plainDoc, { from: caretInFirstParagraph(plainDoc) });
    expect(toggleCheckboxDone.isEnabled(plainState)).toBe(false);
    expect(runCommand(toggleCheckboxDone, plainState).applied).toBe(false);
  });

  it("is active only on an already-checked task, and flips checked false -> true -> false on run", () => {
    const doc = docFor("- [ ] item");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(toggleCheckboxDone.isEnabled(state)).toBe(true);
    expect(toggleCheckboxDone.isActive(state)).toBe(false);

    const checked = runCommand(toggleCheckboxDone, state);
    expect(checked.applied).toBe(true);
    const checkedItemPos = findNodePos(checked.next.doc, "list_item");
    expect(checked.next.doc.nodeAt(checkedItemPos)?.attrs.checked).toBe(true);
    expect(toggleCheckboxDone.isActive(checked.next)).toBe(true);

    const unchecked = runCommand(toggleCheckboxDone, checked.next);
    expect(unchecked.applied).toBe(true);
    const uncheckedItemPos = findNodePos(unchecked.next.doc, "list_item");
    expect(unchecked.next.doc.nodeAt(uncheckedItemPos)?.attrs.checked).toBe(false);
  });

  // ---- Safety: Mod-Shift-Enter can never reach a sent Entry's real Task
  // (issue #238) — the same guard checklistRun's single-item "turn the task
  // off" path already has (issue #235), applied here too. Fixture and
  // selection shape match that sibling test exactly: the same
  // `bullet_list > list_item > paragraph[" ", task_reference]` doc
  // `commitEntryEdit` (use-history.ts) re-opens a sent Entry's checklist
  // item against, with the caret resolved into the editable whitespace
  // immediately before the (uneditable) reference chip via `selectAllState`.

  it("is disabled, and a no-op on run, on a promoted task_reference-backed item — the sent-Entry case", () => {
    const referencedParagraph = paragraphNodeType.create(null, [
      entrySchema.text(" "),
      taskReference("t1", "buy milk", false),
    ]);
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [listItem(false, referencedParagraph)]),
    ]);
    const state = selectAllState(doc);

    expect(toggleCheckboxDone.isEnabled(state)).toBe(false);

    const { applied, next } = runCommand(toggleCheckboxDone, state);
    expect(applied).toBe(false);
    // No transaction was ever dispatched, so `next` is the exact same
    // EditorState/doc object `state` already was — stronger than structural
    // equality, and the closest this unit-test level (no live EntryStore or
    // persisted body bytes, per ADR-0044) can get to "body byte-identical."
    expect(next).toBe(state);
    expect(next.doc.eq(doc)).toBe(true);

    // The reference's own cached `checked` — standing in for the real
    // Task's completion state at this unit-test level — is untouched too.
    const referenced = findNodePositions(next.doc, "task_reference").map((pos) =>
      next.doc.nodeAt(pos),
    );
    expect(referenced[0]?.attrs.checked).toBe(false);
  });

  // The sibling fixture above (and the #235 one it copies) uses
  // `selectAllState`, a selection SPANNING the item. The gesture this
  // ticket actually describes is a caret — someone re-opens a sent Entry,
  // clicks into the editable whitespace beside the reference chip, and
  // presses the chord with nothing selected. `nearestListItem` reads
  // `$from`, so the two resolve to the same item here, which is precisely
  // why a spanning fixture alone would pass while never exercising the
  // real gesture. `stateAt` puts the caret at position 4: doc(0) >
  // bullet_list(1) > list_item(2) > paragraph(3) > the single space that
  // `taskReferenceNodeView`'s uneditable atom sits after.
  it("refuses a bare caret parked beside the reference chip, not just a selection spanning it", () => {
    const referencedParagraph = paragraphNodeType.create(null, [
      entrySchema.text(" "),
      taskReference("t1", "buy milk", false),
    ]);
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [listItem(false, referencedParagraph)]),
    ]);
    const state = stateAt(doc, { from: 4 });
    expect(state.selection.empty).toBe(true);

    expect(toggleCheckboxDone.isEnabled(state)).toBe(false);

    const { applied, next } = runCommand(toggleCheckboxDone, state);
    expect(applied).toBe(false);
    expect(next).toBe(state);
    expect(next.doc.eq(doc)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// splitListItemUnchecked (issue #210)
// ---------------------------------------------------------------------------

/** A `bullet_list` containing one EMPTY, checked top-level `list_item` — built directly off `entrySchema` rather than through `entryMarkdownToDocument`, since there is no Markdown source text for "a task with no text at all." Exists only to exercise `splitListItem`'s own documented bail-out ("empty item — let the next command handle lifting"), which `splitListItemUnchecked` must preserve unchanged. */
function emptyCheckedItemDoc(): PMNode {
  const paragraph = entrySchema.nodes.paragraph?.create();
  const item = entrySchema.nodes.list_item?.create({ checked: true }, paragraph);
  const list = entrySchema.nodes.bullet_list?.create(null, item);
  const doc = entrySchema.nodes.doc?.create(null, list);
  if (doc === undefined) {
    throw new Error("entrySchema is missing a node type this fixture needs");
  }
  return doc;
}

describe("splitListItemUnchecked", () => {
  it("unchecks the new item when Enter splits at the end of a ticked item's text", () => {
    const doc = docFor("- [x] item");
    const start = caretInFirstParagraph(doc);
    const text = doc.resolve(start).parent.textContent;
    const state = stateAt(doc, { from: start + text.length });

    const { applied, next } = runCommand({ run: splitListItemUnchecked }, state);
    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(2);
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 0))?.attrs.checked).toBe(true);
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 1))?.attrs.checked).toBe(false);
  });

  it("unchecks the new item when Enter splits in the MIDDLE of a ticked item's text — the case `itemAttrs` cannot reach", () => {
    const doc = docFor("- [x] item");
    const start = caretInFirstParagraph(doc);
    const text = doc.resolve(start).parent.textContent; // " item"
    const mid = start + text.indexOf("te"); // inside "item", not at its end
    const state = stateAt(doc, { from: mid });

    const { applied, next } = runCommand({ run: splitListItemUnchecked }, state);
    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(2);
    // The first half keeps the ORIGINAL item's own checked state...
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 0))?.attrs.checked).toBe(true);
    // ...only the newly split-off second half is forced back to unchecked.
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 1))?.attrs.checked).toBe(false);
  });

  it("leaves checked null on a plain (non-checkbox) bullet — Enter there must not mint a checkbox", () => {
    const doc = docFor("- item");
    const start = caretInFirstParagraph(doc);
    const text = doc.resolve(start).parent.textContent;
    const state = stateAt(doc, { from: start + text.length });

    const { applied, next } = runCommand({ run: splitListItemUnchecked }, state);
    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(2);
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 0))?.attrs.checked).toBeNull();
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 1))?.attrs.checked).toBeNull();
  });

  it("leaves checked false on an already-unchecked checklist item", () => {
    const doc = docFor("- [ ] item");
    const start = caretInFirstParagraph(doc);
    const text = doc.resolve(start).parent.textContent;
    const state = stateAt(doc, { from: start + text.length });

    const { applied, next } = runCommand({ run: splitListItemUnchecked }, state);
    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(2);
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 0))?.attrs.checked).toBe(false);
    expect(next.doc.nodeAt(nthNodePos(next.doc, "list_item", 1))?.attrs.checked).toBe(false);
  });

  it("returns false and dispatches nothing on an empty top-level item, the same bail-out real splitListItem documents — leaves outdent.run to lift it out instead", () => {
    const doc = emptyCheckedItemDoc();
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });

    const { applied, next } = runCommand({ run: splitListItemUnchecked }, state);
    expect(applied).toBe(false);
    expect(next).toBe(state);
  });

  it("supports a dry run with no dispatch, like every ProseMirror command", () => {
    const doc = docFor("- [x] item");
    const state = stateAt(doc, { from: caretInFirstParagraph(doc) });
    expect(splitListItemUnchecked(state)).toBe(true);
    // Untouched — a dry run must not mutate the document.
    expect(countNodesOfType(state.doc, "list_item")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-block selections — issue #235, ADR 0072. "Converting existing text
// into a list, nesting it, and converting it back — without losing any of
// it." Everything above this point tests typing INTO a structure; this
// section tests converting content INTO and OUT OF one.
//
// Every fixture below builds its own document directly with `paragraph`/
// `listItem`/`taskReference` (this file's own helpers, above) rather than
// through `entryMarkdownToDocument` — see `paragraph`'s own comment: issue
// #234 (Enter actually splitting a block outside a list) has not shipped
// yet, so there is currently no Markdown source string, and no live
// keystroke sequence, that produces N separate top-level plain blocks at
// all in the real Composer. Direct node construction sidesteps that gap:
// every command under test here reads `state.doc`/`state.selection` alone,
// and none of them cares how the document it was handed was built.
// ---------------------------------------------------------------------------

describe("bulletList/orderedList: N plain blocks -> N items, and back (issue #235)", () => {
  it("wraps N separate plain blocks in N separate list items, never one item holding all of them", () => {
    const doc = entrySchema.node("doc", null, [
      paragraph("alpha"),
      paragraph("bravo"),
      paragraph("charlie"),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(bulletList, state);

    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(3);
    expect(
      findNodePositions(next.doc, "paragraph").map((pos) => next.doc.nodeAt(pos)?.textContent),
    ).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("un-lists back to N separate plain blocks with every item's text unchanged — the non-lossy, Android-matching divergence from macOS's own <br>-joined collapse (ADR 0072, Gap sweep #2 Group G3)", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(null, paragraph("alpha")),
        listItem(null, paragraph("bravo")),
        listItem(null, paragraph("charlie")),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(bulletList, state);

    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(0);
    expect(
      findNodePositions(next.doc, "paragraph").map((pos) => next.doc.nodeAt(pos)?.textContent),
    ).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("does the identical N-items -> N-blocks round trip for orderedList", () => {
    const doc = entrySchema.node("doc", null, [
      orderedListNodeType.create(null, [
        listItem(null, paragraph("first")),
        listItem(null, paragraph("second")),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(orderedList, state);

    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(0);
    expect(
      findNodePositions(next.doc, "paragraph").map((pos) => next.doc.nodeAt(pos)?.textContent),
    ).toEqual(["first", "second"]);
  });
});

describe("un-listing a nested selection flattens one level per press, not UpNote's own alternation (issue #235, ADR 0072, Gap sweep #2 Group I1)", () => {
  it("takes exactly 3 presses to fully flatten a 3-level nested bullet list, each press outdenting whatever is still nested by exactly one level", () => {
    const level3 = bulletListNodeType.create(null, [listItem(null, paragraph("three"))]);
    const level2 = bulletListNodeType.create(null, [listItem(null, paragraph("two"), level3)]);
    const level1 = bulletListNodeType.create(null, [listItem(null, paragraph("one"), level2)]);
    let state = selectAllState(entrySchema.node("doc", null, [level1]));

    // Press 1: "one" had only one level to lose -> fully plain; "two" and
    // "three" both shift up one level, keeping their own relative nesting.
    const press1 = runCommand(bulletList, state);
    expect(press1.applied).toBe(true);
    expect(
      findNodePositions(press1.next.doc, "paragraph").map(
        (pos) => press1.next.doc.nodeAt(pos)?.textContent,
      ),
    ).toEqual(["one", "two", "three"]);
    expect(findNodePositions(press1.next.doc, "list_item")).toHaveLength(2);

    // Press 2: "two" now has only one level to lose -> plain; "three"
    // shifts up one more level. UpNote's own alternation would instead
    // re-nest everything back to 3 levels here (Gap sweep #2 Group I1,
    // press 2) — this Composer keeps outdenting instead.
    state = selectAllState(press1.next.doc);
    const press2 = runCommand(bulletList, state);
    expect(press2.applied).toBe(true);
    expect(findNodePositions(press2.next.doc, "list_item")).toHaveLength(1);
    expect(
      findNodePositions(press2.next.doc, "paragraph").map(
        (pos) => press2.next.doc.nodeAt(pos)?.textContent,
      ),
    ).toEqual(["one", "two", "three"]);

    // Press 3: fully flat.
    state = selectAllState(press2.next.doc);
    const press3 = runCommand(bulletList, state);
    expect(press3.applied).toBe(true);
    expect(findNodePositions(press3.next.doc, "list_item")).toHaveLength(0);
    expect(
      findNodePositions(press3.next.doc, "paragraph").map(
        (pos) => press3.next.doc.nodeAt(pos)?.textContent,
      ),
    ).toEqual(["one", "two", "three"]);

    // A 4th press starts the ordinary create-a-list cycle over — the same
    // toggle direction the very first fixture in this describe block
    // exercises (no list touched at all -> wrap), not a special case of
    // "nothing left to outdent." Confirms `rangeTouchesListType` correctly
    // reports "no" once every list is really gone, rather than getting
    // stuck reporting "yes" from stale state.
    state = selectAllState(press3.next.doc);
    const press4 = runCommand(bulletList, state);
    expect(press4.applied).toBe(true);
    expect(findNodePositions(press4.next.doc, "list_item")).toHaveLength(3);
  });

  it("leaves a completely untouched top-level plain sibling alone", () => {
    const level2 = bulletListNodeType.create(null, [listItem(null, paragraph("two"))]);
    const level1 = bulletListNodeType.create(null, [listItem(null, paragraph("one"), level2)]);
    const doc = entrySchema.node("doc", null, [paragraph("already plain"), level1]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(bulletList, state);

    expect(applied).toBe(true);
    expect(
      findNodePositions(next.doc, "paragraph").map((pos) => next.doc.nodeAt(pos)?.textContent),
    ).toEqual(["already plain", "one", "two"]);
  });
});

describe("Tab never destroys a selection's content (issue #235, ADR 0072 — UpNote's own multi-block Tab destroys text, Gap sweep #2 Group K1)", () => {
  const tabChain = { run: chainCommands(indent.run, insertEmSpace) };

  it("indents EVERY plain block a multi-block selection touches, leaving each block's own text completely intact — the chosen reading of 'indenting every selected block'", () => {
    const doc = entrySchema.node("doc", null, [paragraph("alpha"), paragraph("bravo")]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(tabChain, state);

    expect(applied).toBe(true);
    expect(
      findNodePositions(next.doc, "paragraph").map((pos) => next.doc.nodeAt(pos)?.textContent),
    ).toEqual([" alpha", " bravo"]);
  });

  it("never destroys a genuine text SELECTION within a single plain block either — Tab prepends an em space rather than replacing the selected text", () => {
    const doc = entrySchema.node("doc", null, [paragraph("select me")]);
    const state = stateAt(doc, { from: 1, to: 1 + "select me".length });

    const { applied, next } = runCommand(tabChain, state);

    expect(applied).toBe(true);
    expect(next.doc.textBetween(0, next.doc.content.size)).toBe(" select me");
  });

  it("still swallows Tab unconditionally on a collapsed caret — ADR 0070's own invariant, unaffected by this ticket's multi-block fix", () => {
    const doc = entrySchema.node("doc", null, [paragraph("abcd")]);
    const state = stateAt(doc, { from: 3 });

    const { applied, next } = runCommand(tabChain, state);

    expect(applied).toBe(true);
    expect(next.doc.textBetween(0, next.doc.content.size)).toBe("ab cd");
  });

  it("falls back to one collapsed em space, never a deletion, when a multi-item list selection has nothing sinkable (starts at a list's own first item, with no preceding sibling for the whole range)", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(null, paragraph("top")),
        listItem(null, paragraph("mid")),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(tabChain, state);

    expect(applied).toBe(true);
    // Neither item's own text is gone — a documented, disclosed limitation
    // (insertEmSpace's own comment): this specific shape does not get
    // genuinely indented, but it is never destroyed either.
    const text = next.doc.textBetween(0, next.doc.content.size, "|");
    expect(text).toContain("top");
    expect(text).toContain("mid");
  });
});

describe("a block containing a soft break survives conversion to a list item and back (issue #235, ADR 0072 — Android permanently splits it instead, Gap sweep #2 Group H2)", () => {
  it("keeps the embedded newline inside ONE list item, never splitting into two — and restores it byte-for-byte on un-list", () => {
    const text = "line one\nline two";
    const doc = entrySchema.node("doc", null, [paragraph(text)]);
    const state = stateAt(doc, { from: 1, to: 1 + text.length });

    const wrapped = runCommand(bulletList, state);
    expect(wrapped.applied).toBe(true);
    expect(findNodePositions(wrapped.next.doc, "list_item")).toHaveLength(1);
    expect(wrapped.next.doc.textBetween(0, wrapped.next.doc.content.size)).toBe(text);

    const restored = runCommand(
      bulletList,
      stateAt(wrapped.next.doc, { from: caretInFirstParagraph(wrapped.next.doc) }),
    );
    expect(restored.applied).toBe(true);
    expect(findNodePositions(restored.next.doc, "list_item")).toHaveLength(0);
    expect(restored.next.doc.textBetween(0, restored.next.doc.content.size)).toBe(text);
  });
});

describe("checklist multi-block: cannot be un-listed, a second press flips every item's checked state, narrowed pre-Send (issue #235, ADR 0053, ADR 0072)", () => {
  it("wraps N plain blocks in a fresh checklist, N unchecked items — matching UpNote's own N-blocks-to-N-items behaviour (Gap sweep #2 Group G2, both platforms)", () => {
    const doc = entrySchema.node("doc", null, [paragraph("milk"), paragraph("eggs")]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(checklist, state);

    expect(applied).toBe(true);
    const items = findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos));
    expect(items).toHaveLength(2);
    expect(items.map((item) => item?.attrs.checked)).toEqual([false, false]);
  });

  it("a second press flips every item's checked state uniformly — never un-lists, matching UpNote's own checklist toggle exactly (Gap sweep #2 Group G3/I3)", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(false, paragraph("milk")),
        listItem(false, paragraph("eggs")),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(checklist, state);

    expect(applied).toBe(true);
    // Still a checklist — never un-listed.
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(2);
    expect(
      findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos)?.attrs.checked),
    ).toEqual([true, true]);
  });

  it("a third press flips back to unchecked, matching UpNote's own true<->false cycle once uniform", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(true, paragraph("milk")),
        listItem(true, paragraph("eggs")),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(checklist, state);

    expect(applied).toBe(true);
    expect(
      findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos)?.attrs.checked),
    ).toEqual([false, false]);
  });

  it("a MIXED selection (some checked, some not) activates every item to checked — UpNote's own 'any inactive -> activate all' rule", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(true, paragraph("milk")),
        listItem(false, paragraph("eggs")),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(checklist, state);

    expect(applied).toBe(true);
    expect(
      findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos)?.attrs.checked),
    ).toEqual([true, true]);
  });

  // ---- Safety: the flip-all can never reach a sent Entry's real Task ----

  it("skips a promoted, task_reference-backed item entirely — its cached checked attribute is never flipped", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(false, paragraph("bare item")),
        listItem(false, paragraphNodeType.create(null, [taskReference("t1", "real task", false)])),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(checklist, state);

    expect(applied).toBe(true);
    const items = findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos));
    expect(items[0]?.attrs.checked).toBe(true); // bare item flips
    expect(items[1]?.attrs.checked).toBe(false); // task-referenced item untouched
  });

  it("refuses outright — applies nothing — when EVERY checklist item touched is task_reference-backed; there is nothing safe left to flip", () => {
    const doc = entrySchema.node("doc", null, [
      paragraph("plain, untouched"),
      bulletListNodeType.create(null, [
        listItem(false, paragraphNodeType.create(null, [taskReference("t1", "real task", false)])),
      ]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(checklist, state);

    expect(applied).toBe(false);
    expect(next).toBe(state);
  });

  it("also refuses on a SINGLE-CARET selection inside a promoted item — the checklist chord's OTHER, pre-existing code path (checklistRun's own 'turn the task off' case), reachable via the editable whitespace immediately beside a re-opened Entry's reference chip even though the chip itself is uneditable", () => {
    // The same shape `commitEntryEdit` (use-history.ts) re-opens this
    // command's own document against once an Entry has been Sent and
    // edited again — built directly here rather than by exercising
    // Send/edit through a live view, which this module's own header
    // comment says never belongs in this file (ADR 0044). Only ONE
    // top-level paragraph exists in this fixture (deliberately, unlike
    // every OTHER fixture in this describe block): a single-item selection
    // never reaches `multiBlockChecklistRun` at all
    // (`selectionSpansMultipleBlocks` needs more than one), so this proves
    // the SAME guard is needed — and present — on `checklistRun`'s
    // original three-case single-item logic too, not only on the new
    // multi-block branch this ticket adds.
    const referencedParagraph = paragraphNodeType.create(null, [
      entrySchema.text(" "),
      taskReference("t1", "buy milk", false),
    ]);
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [listItem(false, referencedParagraph)]),
    ]);
    const state = selectAllState(doc);

    const { applied, next } = runCommand(checklist, state);

    expect(applied).toBe(false);
    expect(next.doc.eq(doc)).toBe(true);
  });
});

describe("a real AllSelection (Cmd+A/Ctrl+A) is handled correctly, not just a TextSelection spanning the whole doc (issue #235 — caught live, against a real browser)", () => {
  it("bulletList: un-lists a SINGLE already-wrapped item under a real AllSelection — the toolbar button went disabled here before this fix, since $from's own depth is 0 for an AllSelection", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [listItem(null, paragraph("solo"))]),
    ]);
    const state = realAllSelectionState(doc);

    expect(bulletList.isEnabled(state)).toBe(true);
    expect(bulletList.isActive(state)).toBe(true);

    const { applied, next } = runCommand(bulletList, state);
    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(0);
    expect(next.doc.textBetween(0, next.doc.content.size)).toBe("solo");
  });

  it("bulletList: N plain blocks -> N items under a real AllSelection", () => {
    const doc = entrySchema.node("doc", null, [paragraph("alpha"), paragraph("bravo")]);
    const state = realAllSelectionState(doc);

    const { applied, next } = runCommand(bulletList, state);
    expect(applied).toBe(true);
    expect(findNodePositions(next.doc, "list_item")).toHaveLength(2);
  });

  it("bulletList: flattens a 3-level nested list one press at a time under a real AllSelection", () => {
    const level3 = bulletListNodeType.create(null, [listItem(null, paragraph("three"))]);
    const level2 = bulletListNodeType.create(null, [listItem(null, paragraph("two"), level3)]);
    const level1 = bulletListNodeType.create(null, [listItem(null, paragraph("one"), level2)]);
    let state = realAllSelectionState(entrySchema.node("doc", null, [level1]));

    const press1 = runCommand(bulletList, state);
    expect(press1.applied).toBe(true);
    expect(findNodePositions(press1.next.doc, "list_item")).toHaveLength(2);

    state = realAllSelectionState(press1.next.doc);
    const press2 = runCommand(bulletList, state);
    expect(press2.applied).toBe(true);
    expect(findNodePositions(press2.next.doc, "list_item")).toHaveLength(1);

    state = realAllSelectionState(press2.next.doc);
    const press3 = runCommand(bulletList, state);
    expect(press3.applied).toBe(true);
    expect(findNodePositions(press3.next.doc, "list_item")).toHaveLength(0);
  });

  it("checklist: converts an EXISTING plain bullet list (built from typed '- ' markers, no checklist yet) under a real AllSelection — found live: wrapAsChecklist alone left the Checklist toolbar button disabled here, since wrapInList refuses a range that is already the list type it's trying to build", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(null, paragraph("milk")),
        listItem(null, paragraph("eggs")),
      ]),
    ]);
    const state = realAllSelectionState(doc);

    expect(checklist.isEnabled(state)).toBe(true);

    const { applied, next } = runCommand(checklist, state);
    expect(applied).toBe(true);
    const items = findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos));
    expect(items).toHaveLength(2);
    expect(items.map((item) => item?.attrs.checked)).toEqual([false, false]);
    // In place -- still ONE bullet_list, not rebuilt into two nested ones.
    expect(findNodePositions(next.doc, "bullet_list")).toHaveLength(1);
  });

  it("checklist: converts a MIX of an existing plain list item and a top-level plain paragraph, in the same selection, under a real AllSelection", () => {
    const doc = entrySchema.node("doc", null, [
      paragraph("plain block"),
      bulletListNodeType.create(null, [listItem(null, paragraph("already listed"))]),
    ]);
    const state = realAllSelectionState(doc);

    const { applied, next } = runCommand(checklist, state);
    expect(applied).toBe(true);
    const items = findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos));
    expect(items).toHaveLength(2);
    expect(items.every((item) => item?.attrs.checked === false)).toBe(true);
    expect(
      findNodePositions(next.doc, "paragraph").map((pos) => next.doc.nodeAt(pos)?.textContent),
    ).toEqual(["plain block", "already listed"]);
  });

  it("checklist: flip-all still applies under a real AllSelection, with the task_reference guard intact", () => {
    const doc = entrySchema.node("doc", null, [
      bulletListNodeType.create(null, [
        listItem(false, paragraph("bare")),
        listItem(false, paragraphNodeType.create(null, [taskReference("t1", "real task", false)])),
      ]),
    ]);
    const state = realAllSelectionState(doc);

    const { applied, next } = runCommand(checklist, state);
    expect(applied).toBe(true);
    const items = findNodePositions(next.doc, "list_item").map((pos) => next.doc.nodeAt(pos));
    expect(items[0]?.attrs.checked).toBe(true);
    expect(items[1]?.attrs.checked).toBe(false);
  });

  it("Tab (insertEmSpace): never destroys a plain paragraph's text under a real AllSelection, and never leaves focus with nothing dispatched", () => {
    const tabChain = { run: chainCommands(indent.run, insertEmSpace) };
    const doc = entrySchema.node("doc", null, [paragraph("alpha bravo")]);
    const state = realAllSelectionState(doc);

    const { applied, next } = runCommand(tabChain, state);
    expect(applied).toBe(true);
    expect(next.doc.textBetween(0, next.doc.content.size)).toBe(" alpha bravo");
  });
});
