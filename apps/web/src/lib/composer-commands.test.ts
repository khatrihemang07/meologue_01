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
import { history, redo, undo } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import {
  bold,
  bulletList,
  checklist,
  code,
  composerCommands,
  indent,
  italic,
  orderedList,
  outdent,
  redoCommand,
  reference,
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
  it("lists exactly the eleven actions the ticket requires, each with a unique id", () => {
    const ids = composerCommands.map((command) => command.id);
    expect(ids).toEqual([
      "bold",
      "italic",
      "code",
      "bulletList",
      "orderedList",
      "checklist",
      "indent",
      "outdent",
      "reference",
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

  it("is enabled on a list item with a preceding sibling, disabled on the first item", () => {
    const doc = docFor("- first\n- second");
    const firstParaPos = caretInFirstParagraph(doc);
    expect(indent.isEnabled(stateAt(doc, { from: firstParaPos }))).toBe(false);

    // The second item's own paragraph, not the first — only an item with a
    // PRECEDING sibling can be sunk under it.
    expect(indent.isEnabled(stateAt(doc, { from: caretInNthParagraph(doc, 2) }))).toBe(true);
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
