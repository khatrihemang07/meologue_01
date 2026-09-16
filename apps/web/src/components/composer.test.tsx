import type { Entry } from "@meologue/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { formatTaskReference } from "@/lib/inline-markdown";
import { Composer, type ComposerHandle } from "./composer";

/**
 * The one test this ticket's own diagnosis says would have caught issue
 * #177: `task_reference` (entry-schema.ts, ADR 0048) had no renderer
 * anywhere the Composer's `EditorView` could reach — no `toDOM` on the
 * schema (a deliberate choice, composer-editor.ts's own module comment),
 * and no entry in composer.tsx's `nodeViews` map either. ProseMirror calls
 * `node.type.spec.toDOM(node)` unconditionally once neither exists, and
 * `TypeError: node.type.spec.toDOM is not a function` inside the mount
 * effect's `useEffect` — with no error boundary anywhere in the app before
 * this ticket's own `app-error-boundary.tsx` — took the whole screen down
 * with it (`History` row `onEdit` -> `loadDocument` ->
 * `entryMarkdownToDocument` -> `view.updateState` -> the crash).
 *
 * jsdom cannot usefully mount a ProseMirror `EditorView` for INTERACTION
 * (ADR 0044's own "no Range, no Selection, no meaningful
 * getBoundingClientRect" — real typing, the picker, and list Enter/lift
 * stay in apps/e2e's composer.spec.ts, against a real browser), but
 * merely constructing a view and rendering a document into it — exactly
 * the crash's own call path — works fine: `EditorView`'s own construction
 * gets as far as `NodeViewDesc.create`/`updateChildren` without touching
 * `Range`/`Selection` at all, which is confirmed here by simply not
 * throwing.
 */
function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    deviceId: "device-a",
    body: "hello",
    // Issue #196: updatedAt starts equal to createdAt
    createdAt: "2026-08-30T09:00:00.000Z",
    updatedAt: "2026-08-30T09:00:00.000Z",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

const TASK_ID = "11111111-2222-4333-8444-555555555555";

describe("Composer", () => {
  it("renders a task reference's cached checkbox and label instead of crashing (issue #177)", () => {
    const body = `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`;

    expect(() =>
      render(<Composer onSend={vi.fn()} editingEntry={entry({ body })} />),
    ).not.toThrow();

    const checkbox = screen.getByRole("checkbox", { name: "buy milk" });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
    expect(screen.getByPlaceholderText("What's on your mind?").textContent).toContain("buy milk");
  });

  it("reflects a checked task reference's cached state", () => {
    const body = `- [x] ${formatTaskReference(TASK_ID, "call mum")}`;

    render(<Composer onSend={vi.fn()} editingEntry={entry({ body })} />);

    expect(screen.getByRole("checkbox", { name: "call mum" })).toBeChecked();
  });

  // The line renders exactly one checkbox — `listItemNodeView`'s own
  // (composer-editor.ts) draws one whenever a `list_item`'s `checked` is
  // non-null, and `taskReferenceNodeView` draws its own inside the
  // paragraph too; without `listItemNodeView`'s own referenced-item guard,
  // a promoted line showed two: `☐ ☐ buy milk`.
  it("draws exactly one checkbox for a referenced line, not two", () => {
    const body = `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`;

    render(<Composer onSend={vi.fn()} editingEntry={entry({ body })} />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  // A bare checkbox (no task reference) is unaffected by any of the above
  // — its own, single checkbox still comes from `listItemNodeView` alone.
  it("still draws exactly one checkbox for an ordinary bare checkbox line", () => {
    render(<Composer onSend={vi.fn()} editingEntry={entry({ body: "- [ ] buy milk" })} />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  // The actual production crash path: History's row `onEdit` sets
  // `editingEntry` on an already-mounted Composer (composer-page.tsx),
  // which composer.tsx's own effect (watching `[editingEntry,
  // loadDocument]`) reacts to by calling `loadDocument` on the LIVE view
  // — `view.updateState`, not a fresh mount. Rendering with `editingEntry`
  // already set (the tests above) exercises the identical `loadDocument`
  // call but skips this specific transition; this test drives it instead.
  it("does not crash when editingEntry transitions, mid-session, onto an Entry holding a task reference", () => {
    const body = `- [ ] ${formatTaskReference(TASK_ID, "buy milk")}`;
    const { rerender } = render(<Composer onSend={vi.fn()} editingEntry={null} />);

    expect(() =>
      rerender(<Composer onSend={vi.fn()} editingEntry={entry({ body })} />),
    ).not.toThrow();

    expect(screen.getByRole("checkbox", { name: "buy milk" })).toBeInTheDocument();
  });

  it("still renders an ordinary Entry Reference (regression guard on the shared nodeViews map)", () => {
    render(<Composer onSend={vi.fn()} editingEntry={entry({ body: "[[2026-08-28]]" })} />);

    expect(screen.getByPlaceholderText("What's on your mind?").textContent).toBe("[[2026-08-28]]");
  });
});

// Android has no Cmd/Ctrl+Enter (submit-chord.ts returns false there
// unconditionally), so Send is the ONLY way to submit an Entry on that
// platform — a tap that blurs the field closes the soft keyboard too.
// Every other doc-mutating control in composer.tsx already follows the
// "steals no caret" rule (this file's own L574-587 comment); these tests
// pin Send to the same rule.
describe("Composer's Send button keeps focus on the editor", () => {
  it("prevents the default mousedown action, exactly like every toolbar button", () => {
    const ref = createRef<ComposerHandle>();
    render(<Composer onSend={vi.fn()} ref={ref} />);
    // A disabled `<button>` fires no mouse events at all (native behaviour,
    // reproduced by jsdom) — Send starts `disabled={isEmpty}` on an empty
    // document, so this needs the same real-transaction seeding the next
    // test uses before the button's `onMouseDown` can be exercised.
    act(() => {
      ref.current?.insertAtCursor("hello");
    });

    // `fireEvent`'s return value is `element.dispatchEvent(event)`'s own
    // result: `false` once something on the way called `preventDefault()`
    // on this (cancelable) event, `true` otherwise — the same assertion
    // shape question-composer.test.tsx's plain-Enter test already uses for
    // "nothing called preventDefault", read the other way round here.
    const dispatchResult = fireEvent.mouseDown(screen.getByRole("button", { name: "Send" }));

    expect(dispatchResult).toBe(false);
  });

  it("refocuses the editor after sending a new Entry, even if focus had already moved elsewhere", () => {
    const onSend = vi.fn();
    const ref = createRef<ComposerHandle>();
    render(<Composer onSend={onSend} ref={ref} />);
    const field = screen.getByPlaceholderText("What's on your mind?");

    // Seeds a non-empty, non-whitespace document through the SAME
    // imperative path the "Refer" action uses (composer-page.tsx) — a real
    // transaction, not a prop, so the Send button's own `disabled={isEmpty}`
    // clears exactly the way a hand-typed Entry would.
    act(() => {
      ref.current?.insertAtCursor("hello");
    });
    // `insertAtCursor` ends with its own `view.focus()` (ComposerHandle's
    // rule, matching the toolbar), so focus has to be moved away again here
    // to set up a state Send's own refocus can be told apart from — without
    // this, the editor would already be focused going into the click, and
    // the assertion below would pass whether or not composer.tsx's `send()`
    // does anything at all.
    act(() => {
      field.blur();
    });
    expect(document.activeElement).not.toBe(field);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("hello", expect.objectContaining({ active: null }));
    expect(document.activeElement).toBe(field);
  });
});
