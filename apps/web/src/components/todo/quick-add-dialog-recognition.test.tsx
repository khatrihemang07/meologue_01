import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutocompleteEntry } from "@/lib/quick-add-autocomplete";
import { useSettingsStore } from "@/lib/settings";
import { QuickAddDialog } from "./quick-add-dialog";

function project(overrides: Partial<AutocompleteEntry> = {}): AutocompleteEntry {
  return {
    id: "p1",
    name: "Errands",
    ...overrides,
  };
}

async function getTitleEditor(): Promise<HTMLElement> {
  return screen.findByLabelText("Task name");
}

// Identical shim to task-detail-view-recognition.test.tsx's own — jsdom
// implements neither `Range.getClientRects` nor a non-zero
// `getBoundingClientRect`, both of which `task-title-editor.tsx`'s
// `popupStyle` reaches via `EditorView.coordsAtPos` the instant a popup is
// open. Scoped to this file alone, matching that file's own reasoning.
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

// Identical reasoning to task-detail-view-recognition.test.tsx's own
// `pasteText`: jsdom has no usable contenteditable typing/IME path, but a
// real `paste` DOM event goes through `prosemirror-view`'s own
// `editHandlers.paste`, which is a normal `docChanged` transaction — the
// same thing the autocomplete plugin's `apply()` needs to see.
function pasteText(target: HTMLElement, text: string): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  target.dispatchEvent(event);
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 10, 12, 0));
  useSettingsStore.setState({ smartDatesEnabled: true });
});

describe("QuickAddDialog — #/@ autocomplete, real editor (issue #261)", () => {
  it("typing '#' opens the listbox with the supplied projects", async () => {
    render(
      <QuickAddDialog open={true} onOpenChange={vi.fn()} onAdd={vi.fn()} projects={[project()]} />,
    );

    const titleEditor = await getTitleEditor();
    pasteText(titleEditor, "#z");

    const listbox = await screen.findByRole("listbox");
    expect(listbox).toBeInTheDocument();
  });

  it("Escape closes only the popup — the dialog stays open and the typed text is intact", async () => {
    const onOpenChange = vi.fn();
    render(
      <QuickAddDialog
        open={true}
        onOpenChange={onOpenChange}
        onAdd={vi.fn()}
        projects={[project()]}
      />,
    );

    const titleEditor = await getTitleEditor();
    pasteText(titleEditor, "#z");
    await screen.findByRole("listbox");

    // One `fireEvent.keyDown` on the real editor node exercises Radix's
    // own document-capture `onEscapeKeyDown` first, then (if not gated
    // off) ProseMirror's bubble-phase `handleKeyDown` — the identical real
    // ordering `task-detail-view-recognition.test.tsx`'s own header
    // comment documents, and the one a raw `<input>` stub can't reproduce.
    fireEvent.keyDown(titleEditor, { key: "Escape" });

    // The popup is gone…
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // …but the dialog itself is still open (Radix's own dismissal never
    // fired: `onOpenChange` was never called with `false`)…
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog", { name: "Quick Add" })).toBeInTheDocument();
    // …and the typed text was never touched by this Escape.
    expect(screen.getByLabelText("Task name")).toHaveTextContent("#z");
  });

  // The `@` label popup rides the identical `quick-add-autocomplete.ts`
  // plugin and the identical `closeAutocompleteRef`, so the fix is shared
  // code — but issue #261 asks for `@` by name, and the live S2 drive
  // (2026-09-14) only ever pressed Escape against `#`. Asserting the `@`
  // half here rather than reasoning that it "must" work: a shared-code
  // argument is exactly the kind of thing that turns out to be wrong.
  it("Escape closes the '@' label popup too, on the same terms", async () => {
    const onOpenChange = vi.fn();
    render(
      <QuickAddDialog
        open={true}
        onOpenChange={onOpenChange}
        onAdd={vi.fn()}
        labels={[project({ id: "l1", name: "errand" })]}
      />,
    );

    const titleEditor = await getTitleEditor();
    pasteText(titleEditor, "@z");
    await screen.findByRole("listbox");

    fireEvent.keyDown(titleEditor, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog", { name: "Quick Add" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task name")).toHaveTextContent("@z");
  });
});
