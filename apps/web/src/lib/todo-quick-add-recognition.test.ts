import type { QuickAddSpan } from "@meologue/core";
import { mustParseLocalDayKey } from "@meologue/core";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { EditorState, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it } from "vitest";
import { taskTitleSchema, titleDocFromText } from "@/components/todo/task-title-editor";
import {
  computeQuickAddMatches,
  matchIdForToken,
  quickAddRecognitionPlugin,
  remapWithdrawnSpans,
} from "./todo-quick-add-recognition";

// "today" = 10 Sep 2026 (Thursday) — matching
// meologue-reference/todoist/quick-add.md's own captured reference instant.
const NOW = mustParseLocalDayKey("2026-09-10");

describe("remapWithdrawnSpans", () => {
  it("returns the same spans, unchanged, when the text hasn't changed", () => {
    const spans: QuickAddSpan[] = [{ start: 0, end: 3 }];
    expect(remapWithdrawnSpans("tod", "tod", spans)).toEqual(spans);
  });

  it("drops a span whose own text was edited — the second Backspace after withdrawal", () => {
    // tod-05-bksp2.json: "tod" -> "to".
    const spans: QuickAddSpan[] = [{ start: 0, end: 3 }];
    expect(remapWithdrawnSpans("tod", "to", spans)).toEqual([]);
  });

  it("drops a span when a character is typed immediately after it", () => {
    // retype-03-todx.json: "tod" -> "todx", typed right after the
    // withdrawn span's own end — this module's own header comment on why
    // a boundary-touching edit counts as touching, not merely an edit to
    // the span's own interior characters.
    const spans: QuickAddSpan[] = [{ start: 0, end: 3 }];
    expect(remapWithdrawnSpans("tod", "todx", spans)).toEqual([]);
  });

  it("stays dropped across the round trip back to the identical text", () => {
    // retype-04-back-to-tod-after-x.json: "todx" -> "tod" (Backspace on
    // the trailing x). Once dropped by the previous edit there is nothing
    // left to remap — the natural parse alone decides the render, and it
    // is fully re-recognised (see the computeQuickAddMatches test below).
    expect(remapWithdrawnSpans("todx", "tod", [])).toEqual([]);
  });

  it("shifts a span forward when new text is inserted well before it, with a real gap", () => {
    const spans: QuickAddSpan[] = [{ start: 6, end: 9 }];
    // "hello tod" -> "XXhello tod" — two characters inserted at the very
    // front; "tod" itself (indices 6-9) sits well clear of the edit.
    expect(remapWithdrawnSpans("hello tod", "XXhello tod", spans)).toEqual([{ start: 8, end: 11 }]);
  });

  it("shifts a span backward when text is removed well before it", () => {
    const spans: QuickAddSpan[] = [{ start: 8, end: 11 }];
    expect(remapWithdrawnSpans("XXhello tod", "hello tod", spans)).toEqual([{ start: 6, end: 9 }]);
  });

  it("drops one of several spans while leaving an untouched one shifted", () => {
    const spans: QuickAddSpan[] = [
      { start: 0, end: 3 }, // "tod" — about to be edited
      { start: 8, end: 11 }, // a second, untouched occurrence further on
    ];
    // Insert "!" right after the first "tod" (index 3) — touches the
    // first span; the second, twelve characters later, only shifts.
    expect(remapWithdrawnSpans("tod aaa tod", "tod! aaa tod", spans)).toEqual([
      { start: 9, end: 12 },
    ]);
  });

  it("leaves an empty span list empty", () => {
    expect(remapWithdrawnSpans("tod", "todx", [])).toEqual([]);
  });
});

describe("matchIdForToken", () => {
  it("carries the resolved date, not the typed text", () => {
    expect(
      matchIdForToken({ kind: "date", start: 0, end: 3, raw: "tod", date: "2026-09-10" }, null),
    ).toBe("2026-09-10");
  });

  it("renders a priority as P<n>, crossing the stored/ui inversion — typed p1 stores 4, renders P1", () => {
    expect(
      matchIdForToken({ kind: "priority", start: 0, end: 2, raw: "p1", priority: 4 }, null),
    ).toBe("P1");
  });

  it("renders the degenerate p4 the same way — typed p4 stores 1, renders P4", () => {
    expect(
      matchIdForToken({ kind: "priority", start: 0, end: 2, raw: "p4", priority: 1 }, null),
    ).toBe("P4");
  });

  it("carries a label's resolved name", () => {
    expect(
      matchIdForToken({ kind: "label", start: 0, end: 8, raw: "@Family", name: "Family" }, null),
    ).toBe("Family");
  });

  // QA-10: a time-only phrase carries no date in meologue where Todoist
  // bundles one in — "12 Sep 5:00 PM" vs. the bare "17:00". The chip's
  // matchId now takes the merged date+time straight from the same
  // parse's own `QuickAddResult.date` (parse-quick-add.ts's
  // mergeDateAndTime), rather than the token's bare `time` field.
  describe("time — QA-10, bundles the resolved day rather than a bare time", () => {
    it("uses the merged date+time when one is supplied", () => {
      expect(
        matchIdForToken(
          { kind: "time", start: 0, end: 5, raw: "5pm", time: "17:00" },
          "2026-09-12T17:00",
        ),
      ).toBe("2026-09-12T17:00");
    });

    it("falls back to the bare time if no merged value is supplied", () => {
      // Defensive only — computeQuickAddMatches always supplies
      // `natural.date`, which mergeDateAndTime guarantees is non-null
      // whenever a "time" token exists at all.
      expect(
        matchIdForToken({ kind: "time", start: 0, end: 5, raw: "5pm", time: "17:00" }, null),
      ).toBe("17:00");
    });
  });
});

describe("computeQuickAddMatches", () => {
  it("recognises 'tod' as a fresh, non-withdrawn match", () => {
    const matches = computeQuickAddMatches("tod", { now: NOW }, []);

    expect(matches).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: false },
    ]);
  });

  it("marks a match withdrawn once its exact span is in the withdrawn list", () => {
    const matches = computeQuickAddMatches("tod", { now: NOW }, [{ start: 0, end: 3 }]);

    expect(matches).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: true },
    ]);
  });

  it("shows no match at all for 'todx' — not a recognisable phrase", () => {
    expect(computeQuickAddMatches("todx", { now: NOW }, [{ start: 0, end: 3 }])).toEqual([]);
  });

  it("re-recognises fully, not withdrawn, once the withdrawn record has been dropped by an edit", () => {
    // The end-to-end shape of retype-03/retype-04: withdraw "tod", type
    // "x" (drops the withdrawal per remapWithdrawnSpans), backspace the
    // "x" away again — nothing left in the withdrawn list, so the natural
    // parse of "tod" renders fully highlighted.
    const afterTyping = remapWithdrawnSpans("tod", "todx", [{ start: 0, end: 3 }]);
    const afterBackspace = remapWithdrawnSpans("todx", "tod", afterTyping);

    expect(computeQuickAddMatches("tod", { now: NOW }, afterBackspace)).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: false },
    ]);
  });

  it("clearing the field and retyping the identical text re-recognises it (QA-07)", () => {
    const afterClear = remapWithdrawnSpans("tod", "", [{ start: 0, end: 3 }]);
    const afterRetype = remapWithdrawnSpans("", "tod", afterClear);

    expect(computeQuickAddMatches("tod", { now: NOW }, afterRetype)).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: false },
    ]);
  });

  // QA-10, end to end: a time-only phrase's chip now bundles the implied
  // day (here "today", NOW's own date) rather than the bare time.
  it("bundles today's date into a time-only phrase's matchId (QA-10)", () => {
    const matches = computeQuickAddMatches("5pm", { now: NOW }, []);

    expect(matches).toEqual([
      { start: 0, end: 3, kind: "time", matchId: "2026-09-10T17:00", withdrawn: false },
    ]);
  });
});

// QA-06 — strict DOM parity, decided 2026-09-12 (meologue-reference/todoist/
// parity-ledger.md's QA-06 row): on withdrawal, meologue must REPLACE the
// recognised span with a new node, exactly as Todoist's own tiebreak
// (meologue-reference/todoist/live-audit-dom/qa06-tiebreak-todoist.json)
// showed — not restyle the held one in place, which is what meologue did
// before this fix (qa06-tiebreak-meologue.json).
//
// This mounts a real `EditorView`, the thing `task-title-editor.tsx`'s own
// header comment says a test here normally can't do ("jsdom implements no
// Range, no Selection... cannot usefully mount"). That limitation is about
// simulating real typing/IME/caret placement through the DOM's own
// Selection APIs — nothing this test needs. `handleKeyDown` and
// `baseKeymap`'s commands read and write `view.state`/`view.dispatch`
// directly, never the DOM selection, so a synthetic `keydown` dispatched
// on `view.dom` drives the exact same code path a real browser keystroke
// does (`prosemirror-view`'s own `editHandlers.keydown`, dist/index.js:
// 3189, calls `view.someProp("handleKeyDown", ...)` before falling back to
// `captureKeyDown`), and ProseMirror's DOM rendering (decoration diffing,
// `patchOuterDeco`) runs for real against jsdom's DOM — a `MutationObserver`
// on it sees exactly what the live tiebreak's own probe saw.
describe("quickAddRecognitionPlugin — DOM node identity on withdrawal (QA-06)", () => {
  let view: EditorView | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = undefined;
    host = undefined;
  });

  function mount(text: string): EditorView {
    const doc = titleDocFromText(text);
    const state = EditorState.create({
      schema: taskTitleSchema,
      doc,
      selection: Selection.atEnd(doc),
      // Same order buildTitlePlugins uses in production: the recognition
      // plugin's own `handleKeyDown` must be asked before `baseKeymap`'s
      // ordinary Backspace (this module's own header comment on
      // `quickAddRecognitionPlugin`).
      plugins: [quickAddRecognitionPlugin(() => ({ now: NOW })), keymap(baseKeymap)],
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({ mount: host }, { state });
    return view;
  }

  function backspace(target: EditorView): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      keyCode: 8,
      which: 8,
      bubbles: true,
      cancelable: true,
    });
    target.dom.dispatchEvent(event);
    return event;
  }

  it("replaces the span with a new node on the first Backspace, and a second Backspace still deletes a character", () => {
    const editorView = mount("tod");
    const editorHost = host as HTMLDivElement;

    const spanBefore = editorHost.querySelector<HTMLElement>(
      '[data-testid="natural-language-match"]',
    );
    expect(spanBefore).not.toBeNull();
    const held = spanBefore as HTMLElement;
    // Sanity check on the recognised (non-withdrawn) rendering this test
    // starts from.
    expect(held.textContent).toBe("tod");
    expect(held.getAttribute("data-match-id")).toBe("2026-09-10");
    expect(held.getAttribute("data-highlighted-match")).toBe("true");
    expect(held.tagName).toBe("SPAN");

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(editorHost, { childList: true, subtree: true, attributes: true });

    // First Backspace: withdraws, deletes no character (QA-04).
    const firstEvent = backspace(editorView);
    // `MutationObserver` callbacks land in a microtask; this test never
    // awaits one, so pull the queued records synchronously instead of
    // relying on the callback ever having run.
    mutations.push(...observer.takeRecords());
    observer.disconnect();

    expect(firstEvent.defaultPrevented).toBe(true);
    expect(editorView.state.doc.textContent).toBe("tod");
    // The caret never moved — no character was deleted, only the
    // highlight withdrawn (QA-04's own width measurement: the text is
    // unchanged).
    expect(editorView.state.selection.from).toBe(3);

    // The held reference is detached — Todoist's own measured behaviour
    // (qa06-tiebreak-todoist.json: `heldIsConnected: false`).
    expect(held.isConnected).toBe(false);

    const spanAfter = editorHost.querySelector<HTMLElement>(
      '[data-testid="natural-language-match"]',
    );
    expect(spanAfter).not.toBeNull();
    const replaced = spanAfter as HTMLElement;
    expect(replaced).not.toBe(held);
    expect(replaced.tagName).toBe("SPAN");
    expect(replaced.textContent).toBe("tod");
    expect(replaced.getAttribute("data-match-id")).toBe("2026-09-10");
    // Withdrawn styling dropped (QA-01/QA-06): no highlight attribute, no
    // class — an ordinary, unstyled span.
    expect(replaced.getAttribute("data-highlighted-match")).toBeNull();
    expect(replaced.className).toBe("");

    // A `childList` mutation replaced the node — never merely patched its
    // attributes — mirroring the tiebreak's own mutation log (one SPAN
    // added, its text node added, the old SPAN removed).
    const childListMutations = mutations.filter((m) => m.type === "childList");
    expect(childListMutations.length).toBeGreaterThan(0);
    const removedTheHeldSpan = childListMutations.some((m) =>
      Array.from(m.removedNodes).includes(held),
    );
    expect(removedTheHeldSpan).toBe(true);
    const addedANewSpan = childListMutations.some((m) =>
      Array.from(m.addedNodes).includes(replaced),
    );
    expect(addedANewSpan).toBe(true);

    // Second Backspace: no longer withdrawable. In a real browser this
    // plugin's own `handleKeyDown` returns `false` WITHOUT calling
    // `preventDefault()` (this module's own header comment on the plugin:
    // "returns `false` without calling `preventDefault()` and
    // `keymap(baseKeymap)` ... deletes the character normally") —
    // deliberately, because `baseKeymap`'s own `Backspace` command
    // (`chainCommands(deleteSelection, joinBackward, selectNodeBackward)`,
    // node_modules/prosemirror-commands/dist/index.js:800) does nothing
    // for a collapsed caret mid-text with no block boundary; the actual
    // character deletion is the BROWSER's native contenteditable editing,
    // which `prosemirror-view`'s own `captureKeyDown` deliberately leaves
    // alone for a plain Backspace (`stopNativeHorizontalDelete`,
    // node_modules/prosemirror-view/dist/index.js:2781-2782, returns
    // `false` in the plain case) and its `DOMObserver` then reconciles
    // into a transaction. jsdom implements no native contenteditable
    // engine to originate that edit — the same gap task-title-editor.tsx's
    // own header comment names for real typing — so this asserts the part
    // that IS this plugin's own responsibility (letting the keystroke
    // through unprevented) and then performs the DOM edit a real browser
    // would have made, handing it to ProseMirror's own reconciliation
    // path exactly as its `DOMObserver` does for a genuine native edit.
    const secondEvent = backspace(editorView);
    expect(secondEvent.defaultPrevented).toBe(false);
    expect(editorView.state.doc.textContent).toBe("tod");

    const textNode = replaced.firstChild as Text;
    expect(textNode.nodeType).toBe(Node.TEXT_NODE);
    textNode.deleteData(2, 1); // "tod" -> "to", the native edit itself.
    // `domObserver` is ProseMirror's own reconciliation entry point, but not
    // part of its public types.
    (editorView as unknown as { domObserver: { flush(): void } }).domObserver.flush();

    expect(editorView.state.doc.textContent).toBe("to");
    expect(editorView.state.selection.from).toBe(2);
    // "to" no longer parses as a date — the span disappears entirely.
    expect(editorHost.querySelector('[data-testid="natural-language-match"]')).toBeNull();
  });
});
