import { afterEach, describe, expect, it } from "vitest";
import {
  bindingById,
  chordFor,
  focusAddTaskField,
  focusedTaskId,
  formatKeyHint,
  groupedBindingsBySection,
  hintForId,
  isTypingTarget,
  TODO_KEY_BINDINGS,
} from "./todo-keymap";

describe("isTypingTarget", () => {
  it("is true for an input and a textarea", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
  });

  // jsdom doesn't implement `isContentEditable` at all (it's always
  // `undefined`, real-browser-only) — `Object.defineProperty` stands in
  // for what a real browser computes from the `contenteditable` attribute
  // (`task-title-editor.tsx`'s ProseMirror mount, the Quick Add field this
  // guard exists for, is exactly this shape).
  it("is true for anything contentEditable", () => {
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });

    expect(isTypingTarget(editable)).toBe(true);
  });

  it("is false for a plain element, and for null", () => {
    const div = document.createElement("div");
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("focusedTaskId", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reads the nearest ancestor's data-task-id off document.activeElement", () => {
    document.body.innerHTML = `
      <li data-task-id="parent">
        <div data-task-id="child"><button id="btn">x</button></div>
      </li>
    `;
    (document.getElementById("btn") as HTMLButtonElement).focus();

    expect(focusedTaskId()).toBe("child");
  });

  it("is null when nothing focused sits inside a Task row", () => {
    document.body.innerHTML = `<button id="btn">x</button>`;
    (document.getElementById("btn") as HTMLButtonElement).focus();

    expect(focusedTaskId()).toBeNull();
  });
});

describe("chordFor", () => {
  it("builds a bare letter chord with no modifiers", () => {
    expect(chordFor({ key: "t", metaKey: false, ctrlKey: false, shiftKey: false })).toBe("t");
  });

  it("prepends mod for metaKey or ctrlKey", () => {
    expect(chordFor({ key: "e", metaKey: true, ctrlKey: false, shiftKey: false })).toBe("mod+e");
    expect(chordFor({ key: "e", metaKey: false, ctrlKey: true, shiftKey: false })).toBe("mod+e");
  });

  it("prepends shift for a letter held with Shift", () => {
    expect(chordFor({ key: "T", metaKey: false, ctrlKey: false, shiftKey: true })).toBe("shift+t");
  });

  it("does not double-count Shift for a symbol where Shift is already baked into event.key", () => {
    // Shift+/ reports key "?" — there is no separate "shift+?" to build.
    expect(chordFor({ key: "?", metaKey: false, ctrlKey: false, shiftKey: true })).toBe("?");
  });

  it("does add shift for a non-letter key where Shift is a real, independent modifier", () => {
    expect(chordFor({ key: "Delete", metaKey: false, ctrlKey: false, shiftKey: true })).toBe(
      "shift+delete",
    );
    expect(chordFor({ key: "Backspace", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(
      "mod+backspace",
    );
  });
});

describe("formatKeyHint", () => {
  it("formats a single chord", () => {
    expect(formatKeyHint(["mod+e"])).toBe("⌘E");
    expect(formatKeyHint(["shift+t"])).toBe("⇧T");
    expect(formatKeyHint(["?"])).toBe("?");
    expect(formatKeyHint(["."])).toBe(".");
  });

  it("joins alternates with 'or'", () => {
    expect(formatKeyHint(["mod+backspace", "shift+delete"])).toBe("⌘⌫ or ⇧Delete");
  });

  it("formats a sequence as 'then'", () => {
    expect(formatKeyHint(["g i"])).toBe("G then I");
  });
});

describe("hintForId", () => {
  it("returns the formatted hint for a wired binding id", () => {
    expect(hintForId("edit-task")).toBe("⌘E");
  });

  it("returns null for an id nothing wires (e.g. Move to…, deliberately unimplemented)", () => {
    expect(hintForId("move-to")).toBeNull();
  });
});

describe("bindingById", () => {
  it("finds a binding by id", () => {
    expect(bindingById("show-shortcuts")?.keys).toEqual(["?"]);
  });

  it("returns undefined for an unknown id", () => {
    expect(bindingById("nope")).toBeUndefined();
  });

  // KBD-01/KBD-06 (parity ledger) — the missed (b)s this ticket added.
  it("finds every binding added for KBD-01/KBD-06", () => {
    expect(bindingById("complete-task")?.keys).toEqual(["e"]);
    expect(bindingById("comment-task")?.keys).toEqual(["c"]);
    expect(bindingById("copy-link")?.keys).toEqual(["mod+shift+c"]);
    expect(bindingById("go-settings")?.keys).toEqual(["o s"]);
    expect(bindingById("focus-add-task")?.keys).toEqual(["a"]);
  });

  // Coordinator's own re-audit found three more, added in a second pass.
  it("finds every binding added by the coordinator's re-audit", () => {
    expect(bindingById("go-labels")?.keys).toEqual(["g l"]);
    expect(bindingById("go-reporting")?.keys).toEqual(["g a"]);
    expect(bindingById("go-themes")?.keys).toEqual(["o t"]);
  });
});

describe("focusAddTaskField", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the Add-task field's live role=textbox descendant", () => {
    document.body.innerHTML = `
      <div data-add-task-field>
        <div role="textbox" tabindex="0" id="field"></div>
      </div>
    `;

    focusAddTaskField();

    expect(document.activeElement).toBe(document.getElementById("field"));
  });

  it("is a silent no-op when the field isn't in the DOM", () => {
    expect(() => focusAddTaskField()).not.toThrow();
  });
});

describe("groupedBindingsBySection", () => {
  it("merges quick-find's two split bindings back into one display row", () => {
    const sections = groupedBindingsBySection();
    const general = sections.find((s) => s.section === "General");
    const quickFind = general?.rows.find((row) => row.label === "Quick find");

    expect(quickFind?.keys).toEqual(["/", "f", "mod+k"]);
  });

  it("covers every binding in TODO_KEY_BINDINGS exactly once", () => {
    const sections = groupedBindingsBySection();
    const totalKeys = sections
      .flatMap((s) => s.rows)
      .reduce((sum, row) => sum + row.keys.length, 0);
    const sourceKeys = TODO_KEY_BINDINGS.reduce((sum, binding) => sum + binding.keys.length, 0);

    expect(totalKeys).toBe(sourceKeys);
  });
});
