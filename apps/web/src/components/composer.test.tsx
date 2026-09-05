import type { Entry } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatTaskReference } from "@/lib/inline-markdown";
import { Composer } from "./composer";

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
