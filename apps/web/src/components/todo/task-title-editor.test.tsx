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
import { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import {
  quickAddAutocompletePlugin,
  quickAddAutocompletePluginKey,
} from "@/lib/quick-add-autocomplete";
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

describe("TaskTitleEditor — #/@ autocomplete popup", () => {
  let view: EditorView | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = undefined;
    host = undefined;
  });

  function mount(options: {
    text?: string;
    projects?: AutocompleteEntry[];
    labels?: AutocompleteEntry[];
    onCreateProject?: (name: string) => void;
    onCreateLabel?: (name: string) => void;
    commit?: () => void;
    cancel?: () => void;
  }): { view: EditorView; commit: () => void; cancel: () => void } {
    const commit = options.commit ?? vi.fn();
    const cancel = options.cancel ?? vi.fn();
    const autocompletePlugin = quickAddAutocompletePlugin(() => ({
      getProjects: () => options.projects ?? [],
      getLabels: () => options.labels ?? [],
      onCreateProject: options.onCreateProject,
      onCreateLabel: options.onCreateLabel,
    }));
    const doc = titleDocFromText(options.text ?? "");
    const state = EditorState.create({
      schema: taskTitleSchema,
      doc,
      selection: Selection.atEnd(doc),
      // The REAL plugin list, autocomplete included — this suite's own
      // header comment on why a hand-rolled `[autocompletePlugin,
      // keymap(baseKeymap)]` array would only prove the plugin works in
      // isolation, not that `buildTitlePlugins` orders it correctly
      // against `commitKeymap`.
      plugins: buildTitlePlugins({
        placeholder: undefined,
        extraPlugins: [],
        commit,
        cancel,
        autocompletePlugin,
      }),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({ mount: host }, { state });
    return { view, commit, cancel };
  }

  function type(target: EditorView, text: string): void {
    target.dispatch(target.state.tr.insertText(text, target.state.selection.from));
  }

  function pressKey(target: EditorView, keyName: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true });
    target.dom.dispatchEvent(event);
    return event;
  }

  it("opens a listbox on '#', listing every Project, and the typed query filters it", () => {
    const { view: editorView } = mount({
      projects: [
        { id: "1", name: "Inbox" },
        { id: "2", name: "Work" },
      ],
    });

    type(editorView, "#");
    let popup = quickAddAutocompletePluginKey.getState(editorView.state);
    expect(popup?.sigil).toBe("#");
    expect(popup?.options).toEqual([
      { kind: "entry", entry: { id: "1", name: "Inbox" } },
      { kind: "entry", entry: { id: "2", name: "Work" } },
    ]);

    type(editorView, "wo");
    popup = quickAddAutocompletePluginKey.getState(editorView.state);
    expect(popup?.query).toBe("wo");
    expect(popup?.options).toEqual([{ kind: "entry", entry: { id: "2", name: "Work" } }]);
  });

  it("opens the identical popup on '@', listing Labels instead of Projects", () => {
    const { view: editorView } = mount({ labels: [{ id: "9", name: "urgent" }] });

    type(editorView, "@urg");
    const popup = quickAddAutocompletePluginKey.getState(editorView.state);
    expect(popup?.sigil).toBe("@");
    expect(popup?.options).toEqual([{ kind: "entry", entry: { id: "9", name: "urgent" } }]);
  });

  it("ArrowDown moves the active option, and Enter inserts the canonical token", () => {
    const { view: editorView } = mount({
      projects: [
        { id: "1", name: "Inbox" },
        { id: "2", name: "Work" },
      ],
    });

    type(editorView, "#");
    expect(quickAddAutocompletePluginKey.getState(editorView.state)?.activeIndex).toBe(0);

    const downEvent = pressKey(editorView, "ArrowDown");
    expect(downEvent.defaultPrevented).toBe(true);
    expect(quickAddAutocompletePluginKey.getState(editorView.state)?.activeIndex).toBe(1);

    const enterEvent = pressKey(editorView, "Enter");
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(editorView.state.doc.textContent).toBe("#Work ");
    expect(quickAddAutocompletePluginKey.getState(editorView.state)).toBeNull();
  });

  it("ArrowUp wraps to the last option, and Tab selects exactly like Enter", () => {
    const { view: editorView } = mount({
      projects: [
        { id: "1", name: "Inbox" },
        { id: "2", name: "Work" },
      ],
    });

    type(editorView, "#");
    pressKey(editorView, "ArrowUp");
    expect(quickAddAutocompletePluginKey.getState(editorView.state)?.activeIndex).toBe(1);

    const tabEvent = pressKey(editorView, "Tab");
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(editorView.state.doc.textContent).toBe("#Work ");
  });

  it("Escape closes only the popup — the composer's own cancel is not called", () => {
    const cancel = vi.fn();
    const { view: editorView } = mount({ projects: [{ id: "1", name: "Inbox" }], cancel });

    type(editorView, "#");
    expect(quickAddAutocompletePluginKey.getState(editorView.state)).not.toBeNull();

    const firstEscape = pressKey(editorView, "Escape");
    expect(firstEscape.defaultPrevented).toBe(true);
    expect(quickAddAutocompletePluginKey.getState(editorView.state)).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    // The typed text is untouched — closing the popup discards only the
    // popup, never the draft.
    expect(editorView.state.doc.textContent).toBe("#");

    // With the popup already closed, a SECOND Escape reaches `commitKeymap`
    // normally — proving this plugin's own precedence over `commitKeymap`
    // doesn't swallow Escape outright, only while a popup is actually open.
    pressKey(editorView, "Escape");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("shows Todoist's 'Create' fallback once the query matches no Project, and selecting it inserts the token and calls the create hook", () => {
    const onCreateProject = vi.fn();
    const { view: editorView } = mount({
      projects: [{ id: "1", name: "Inbox" }],
      onCreateProject,
    });

    type(editorView, "#brandnew");
    const popup = quickAddAutocompletePluginKey.getState(editorView.state);
    expect(popup?.options).toEqual([{ kind: "create", query: "brandnew" }]);

    pressKey(editorView, "Enter");
    expect(onCreateProject).toHaveBeenCalledWith("brandnew");
    expect(editorView.state.doc.textContent).toBe("#brandnew ");
  });

  it("selecting 'Create' with no onCreateProject hook still inserts the token — Create is unbuilt only where wiring is missing, never a dead end", () => {
    const { view: editorView } = mount({ projects: [] });

    type(editorView, "#zzznope");
    pressKey(editorView, "Enter");

    expect(editorView.state.doc.textContent).toBe("#zzznope ");
  });

  it("a bare '@' with zero Labels opens an empty listbox, and Enter still submits normally (Todoist's own captured empty-listbox case)", () => {
    const commit = vi.fn();
    const { view: editorView } = mount({ labels: [], commit });

    type(editorView, "@");
    const popup = quickAddAutocompletePluginKey.getState(editorView.state);
    expect(popup?.options).toEqual([]);

    // The autocomplete plugin itself returns `false` here (nothing to
    // select), letting `commitKeymap`'s own `Enter` binding run instead —
    // `prosemirror-keymap`'s own wrapper calls `preventDefault()` whenever
    // ANY bound command returns true, so `defaultPrevented` being `true`
    // here reflects `commitKeymap` handling it, not this plugin.
    pressKey(editorView, "Enter");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("closes on its own once a space is typed, ending the trigger run", () => {
    const { view: editorView } = mount({ projects: [{ id: "1", name: "Inbox" }] });

    type(editorView, "#In");
    expect(quickAddAutocompletePluginKey.getState(editorView.state)).not.toBeNull();

    type(editorView, " ");
    expect(quickAddAutocompletePluginKey.getState(editorView.state)).toBeNull();
  });
});
