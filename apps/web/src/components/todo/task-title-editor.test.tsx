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
import { cleanup, render, screen } from "@testing-library/react";
import { redo, undo } from "prosemirror-history";
import type { InputRule } from "prosemirror-inputrules";
import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { EditorState, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import {
  quickAddAutocompletePlugin,
  quickAddAutocompletePluginKey,
} from "@/lib/quick-add-autocomplete";
import {
  buildTitlePlugins,
  linkInputRule,
  TaskTitleEditor,
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

// ---------------------------------------------------------------------------
// linkInputRule (issue #373) — typed `[text](url)` becomes a live link
// ---------------------------------------------------------------------------

/**
 * `linkInputRule`'s own doc comment has the full "fires on typing only"
 * story; this section is about HOW that's tested. `prosemirror-inputrules`
 * only ever runs a rule from `handleTextInput`, which fires from a real
 * DOM text-input/composition event — jsdom cannot originate one (this
 * file's own "DOM node identity" suite already leans on that gap for
 * Backspace; `composer-editor.test.ts`'s own module comment has the fuller
 * account, including the exact failure mode: an atomic `insertText(fullString)`
 * call does NOT reliably go through the same path a real keystroke does —
 * `.scratch/todoist-add-todo/web/02-detection-corpus.md` measured this
 * directly against the live Todoist app: pasting-in `"[text](url)"` in one
 * call produced an EMPTY editor, while retyping the identical string one
 * character at a time produced the live link). So, like
 * `composer-editor.test.ts`, this calls the rule's own `match`/`handler`
 * pair directly — `InputRule`'s two properties actually assigned at
 * runtime by its constructor despite being `@internal`-tagged in its
 * public `.d.ts` — rather than trusting a mounted view's `insertText` to
 * exercise it. A live, real-keystroke round trip belongs in `apps/e2e`.
 */
interface InspectableInputRule {
  readonly match: RegExp;
  readonly handler: (
    state: EditorState,
    match: RegExpMatchArray,
    start: number,
    end: number,
  ) => Transaction | null;
}

function inspect(rule: InputRule): InspectableInputRule {
  return rule as unknown as InspectableInputRule;
}

/**
 * Types `text` onto the end of `doc`, one character at a time, running
 * `linkInputRule()`'s own `match`/`handler` after each one — the identical
 * technique `composer-editor.test.ts`'s own `typeAt` uses, simplified for
 * this schema's flat `text*` content: no paragraph wrapper means a
 * document position already IS a plain-text offset (this file's own "DOM
 * node identity" suite: `selection.from` reads `3` after typing `"tod"`),
 * so there's no block-start resolution to do first.
 */
function typeCharByChar(doc: PMNode, text: string): PMNode {
  let state = EditorState.create({
    schema: taskTitleSchema,
    doc,
    selection: Selection.atEnd(doc),
  });
  const rule = inspect(linkInputRule());
  for (const ch of text) {
    const pos = state.selection.from;
    const textBefore = state.doc.textBetween(0, pos) + ch;
    const match = rule.match.exec(textBefore);
    const tr =
      match !== null
        ? (rule.handler(state, match, pos - (match[0].length - ch.length), pos) ??
          state.tr.insertText(ch, pos))
        : state.tr.insertText(ch, pos);
    state = state.apply(tr);
  }
  return state.doc;
}

describe("linkInputRule (issue #373)", () => {
  it("typing [text](url) produces a live link, brackets consumed", () => {
    const doc = typeCharByChar(titleDocFromText(""), "[Todoist](https://todoist.com)");

    expect(doc.textContent).toBe("Todoist");
    expect(titleTextFromDoc(doc)).toBe("[Todoist](https://todoist.com)");
    const linkMark = taskTitleSchema.marks.link.isInSet(doc.firstChild?.marks ?? []);
    expect(linkMark?.attrs.href).toBe("https://todoist.com");
  });

  it("fires mid-sentence too, not only at the start", () => {
    const doc = typeCharByChar(titleDocFromText("Read "), "[this](https://example.com)");

    expect(doc.textContent).toBe("Read this");
    expect(titleTextFromDoc(doc)).toBe("Read [this](https://example.com)");
  });

  it("the link mark does not leak onto the next typed character", () => {
    const linked = typeCharByChar(titleDocFromText(""), "[Todoist](https://todoist.com)");
    const doc = typeCharByChar(linked, "!");

    expect(doc.textContent).toBe("Todoist!");
    const lastChar = doc.lastChild;
    expect(lastChar?.text).toBe("!");
    expect(taskTitleSchema.marks.link.isInSet(lastChar?.marks ?? [])).toBeUndefined();
  });

  it("does not fire on an empty link text or an empty url", () => {
    const emptyText = typeCharByChar(titleDocFromText(""), "[](https://example.com)");
    expect(emptyText.textContent).toBe("[](https://example.com)");

    const emptyHref = typeCharByChar(titleDocFromText(""), "[Todoist]()");
    expect(emptyHref.textContent).toBe("[Todoist]()");
  });
});

// ---------------------------------------------------------------------------
// titleDocFromText / titleTextFromDoc round trip (issue #373)
// ---------------------------------------------------------------------------

describe("titleDocFromText / titleTextFromDoc round trip (issue #373)", () => {
  it("re-parses an already-stored [text](url) back into a live link", () => {
    const doc = titleDocFromText("Read [my article](https://example.com/post)");

    expect(doc.textContent).toBe("Read my article");
    const linkNode = doc.child(1);
    const linkMark = taskTitleSchema.marks.link.isInSet(linkNode.marks);
    expect(linkNode.text).toBe("my article");
    expect(linkMark?.attrs.href).toBe("https://example.com/post");
  });

  it("round-trips byte-for-byte through titleTextFromDoc", () => {
    const original = "Read [my article](https://example.com/post) before lunch";
    expect(titleTextFromDoc(titleDocFromText(original))).toBe(original);
  });

  it("leaves plain text with no bracket syntax completely untouched", () => {
    const original = "buy milk tomorrow";
    const doc = titleDocFromText(original);
    expect(doc.marks?.length ?? 0).toBe(0);
    expect(titleTextFromDoc(doc)).toBe(original);
  });

  it("does not convert a malformed or empty-part link on load either — same rule as typing", () => {
    const original = "See [](https://example.com) and [Todoist]()";
    expect(titleTextFromDoc(titleDocFromText(original))).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Paste behaviour (issue #373): a URL pastes as plain text; a multi-line
// paste defers to `onMultiLinePaste` instead of silently collapsing.
// ---------------------------------------------------------------------------

/**
 * jsdom implements neither method AT ALL on `Range` (verified directly —
 * `"getClientRects" in document.createRange()` is `false`) — mounting the
 * real `TaskTitleEditor` below and dispatching a real transaction reaches
 * `EditorView.coordsAtPos` (`prosemirror-view`'s own `scrollToSelection`,
 * called from `updateState` after every dispatch). `task-row-
 * recognition.test.tsx`/`task-detail-view-recognition.test.tsx` both carry
 * this identical shim for the identical reason; repeated here rather than
 * shared, matching those two files' own precedent of not sharing it with
 * each other.
 */
beforeAll(() => {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = (): DOMRectList => [] as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = (): DOMRect =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON() {
          return this;
        },
      }) as DOMRect;
  }
});

/**
 * Dispatches a real `paste` DOM event carrying only `text/plain` —
 * `prosemirror-view`'s own `editHandlers.paste` reads `clipboardData`
 * directly and applies `view.someProp("transformPasted")` through an
 * ordinary transaction, never through the DOM's own Selection/Range APIs
 * or a `handleTextInput`-style event jsdom can't originate — verified
 * working in this codebase already by `task-row-recognition.test.tsx`'s
 * and `task-detail-view-recognition.test.tsx`'s own identical helper,
 * copied here rather than shared (same reasoning those two files give for
 * not sharing it with each other).
 */
function pasteText(target: HTMLElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  target.dispatchEvent(event);
  return event;
}

/**
 * Mounts the REAL `TaskTitleEditor` component (not a hand-built
 * `EditorView`) — the only way to exercise `transformPasted`'s own
 * "read `onMultiLinePaste` through a live ref" wiring, rather than a
 * re-implementation of it that would only prove the re-implementation
 * works. `render`/`fireEvent` mirror `task-row-recognition.test.tsx`'s own
 * approach to the identical component, one layer down (no `TaskRow`
 * wrapper needed for this file's own purposes).
 */
function mountEditor(onMultiLinePaste?: (lines: string[]) => void): HTMLElement {
  render(
    <TaskTitleEditor
      value=""
      onCommit={() => {}}
      onCancel={() => {}}
      onMultiLinePaste={onMultiLinePaste}
    />,
  );
  const editor = screen.getByRole("textbox", { name: "Task name" });
  return editor;
}

describe("paste behaviour (issue #373)", () => {
  afterEach(() => {
    cleanup();
  });

  it("a pasted URL stays plain text — no link mark, unaffected by linkInputRule", () => {
    const editor = mountEditor();

    pasteText(editor, "https://example.com");

    expect(editor.textContent).toBe("https://example.com");
    expect(editor.querySelector("a")).toBeNull();
  });

  it("a pasted [text](url) string stays literal — the input rule never sees a paste", () => {
    const editor = mountEditor();

    pasteText(editor, "[Todoist](https://todoist.com)");

    expect(editor.textContent).toBe("[Todoist](https://todoist.com)");
    expect(editor.querySelector("a")).toBeNull();
  });

  it("a single-line paste with no onMultiLinePaste supplied inserts it directly, unchanged", () => {
    const editor = mountEditor();

    pasteText(editor, "buy milk");

    expect(editor.textContent).toBe("buy milk");
  });

  it("a multi-line paste with no onMultiLinePaste supplied collapses to one line — the pre-#373 rename/detail-view behaviour, untouched", () => {
    const editor = mountEditor(undefined);

    pasteText(editor, "Task A\nTask B\nTask C");

    expect(editor.textContent).toBe("Task A Task B Task C");
  });

  it("a multi-line paste with onMultiLinePaste supplied inserts NOTHING and defers to the callback with every line", () => {
    const onMultiLinePaste = vi.fn();
    const editor = mountEditor(onMultiLinePaste);

    pasteText(editor, "Task A\nTask B\nTask C");

    expect(onMultiLinePaste).toHaveBeenCalledTimes(1);
    expect(onMultiLinePaste).toHaveBeenCalledWith(["Task A", "Task B", "Task C"]);
    // The field is left exactly as it was before the paste — the dialog,
    // not this field, is what shows the pasted lines.
    expect(editor.textContent).toBe("");
  });

  it("a single-line paste still inserts normally even with onMultiLinePaste supplied", () => {
    const onMultiLinePaste = vi.fn();
    const editor = mountEditor(onMultiLinePaste);

    pasteText(editor, "buy milk");

    expect(onMultiLinePaste).not.toHaveBeenCalled();
    expect(editor.textContent).toBe("buy milk");
  });

  it("blank lines in the pasted text don't count towards the multi-line decision", () => {
    const onMultiLinePaste = vi.fn();
    const editor = mountEditor(onMultiLinePaste);

    // One real line, padded with blank ones — not "3 tasks."
    pasteText(editor, "\nbuy milk\n\n");

    expect(onMultiLinePaste).not.toHaveBeenCalled();
    expect(editor.textContent).toBe("buy milk");
  });
});
