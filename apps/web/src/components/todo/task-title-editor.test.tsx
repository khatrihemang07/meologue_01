/**
 * Direct unit coverage for a genuine pre-existing bug: `Mod-z`/`Shift-
 * Mod-z` silently did nothing in every editor built on this file, because
 * `buildTitlePlugins`' own plugin list bound `undo`/`redo`
 * (`prosemirror-history`) in a keymap without ever registering `history()`
 * — the plugin that records the done/undone step stacks those two
 * commands read (`task-title-editor.tsx`'s own header comment on
 * `history()` has the full account, including why `buildTitlePlugins` is
 * exported at all: so this suite can build a state with the REAL plugin
 * list this editor mounts with, not a hand-rolled stand-in that would only
 * prove `prosemirror-history` itself works).
 *
 * `composer-commands.test.ts`'s own "undo / redo" describe block is the
 * model this file follows: no `EditorView` anywhere (`task-title-
 * editor.tsx`'s own header comment on why jsdom can't usefully host one —
 * true for typing/IME, not for building a plain `EditorState` and running
 * a command against it), a bare `insertText` transaction standing in for
 * a keystroke, and `undo`/`redo` invoked directly via a capturing
 * `dispatch`.
 */
import { redo, undo } from "prosemirror-history";
import type { Transaction } from "prosemirror-state";
import { EditorState, Selection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import {
  buildTitlePlugins,
  taskTitleSchema,
  titleDocFromText,
  titleTextFromDoc,
} from "./task-title-editor";

/**
 * The real `EditorState` this editor mounts with (`TaskTitleEditor`'s own
 * mount effect: `taskTitleSchema`, `Selection.atEnd`, `buildTitlePlugins`)
 * — seeded with `text`, nothing more. `commit`/`cancel` are no-ops: this
 * suite never presses Enter or Escape, only ever inserts text and runs
 * `undo`/`redo` against the result.
 */
function stateFor(text: string): EditorState {
  const doc = titleDocFromText(text);
  return EditorState.create({
    schema: taskTitleSchema,
    doc,
    selection: Selection.atEnd(doc),
    plugins: buildTitlePlugins({
      placeholder: undefined,
      extraPlugins: [],
      commit: () => {},
      cancel: () => {},
    }),
  });
}

/**
 * Runs `undo`/`redo` (both `(state, dispatch?) => boolean`) via a
 * capturing `dispatch`, returning the resulting state —
 * `composer-commands.test.ts`'s own `runCommand` helper, minus the
 * `{ run }` wrapper object `composer-commands.ts`'s registry adds: these
 * two are called directly, exactly as `historyKeymap` (task-title-
 * editor.tsx) calls them.
 */
function runHistoryCommand(
  command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
  state: EditorState,
): { applied: boolean; next: EditorState } {
  let captured: Transaction | null = null;
  const applied = command(state, (tr) => {
    captured = tr;
  });
  return { applied, next: captured === null ? state : state.apply(captured) };
}

describe("buildTitlePlugins — history()", () => {
  it("undo/redo are no-ops on a fresh document (nothing to revert yet)", () => {
    const state = stateFor("hello");
    expect(undo(state)).toBe(false);
    expect(redo(state)).toBe(false);
  });

  it("reverts typed text on undo, and redo brings it back — regression: this returned false/did nothing before history() was registered", () => {
    const state = stateFor("hello");

    // `taskTitleSchema`'s `doc` holds `text*` directly with no wrapping
    // block (this file's own header comment) — unlike `entrySchema`'s
    // paragraph-wrapped documents, `content.size` itself is the position
    // right after the last character, not one past it.
    const edited = state.apply(state.tr.insertText(" world", state.doc.content.size));
    expect(titleTextFromDoc(edited.doc)).toBe("hello world");

    const undone = runHistoryCommand(undo, edited);
    expect(undone.applied).toBe(true);
    expect(titleTextFromDoc(undone.next.doc)).toBe("hello");

    const redone = runHistoryCommand(redo, undone.next);
    expect(redone.applied).toBe(true);
    expect(titleTextFromDoc(redone.next.doc)).toBe("hello world");
  });
});
