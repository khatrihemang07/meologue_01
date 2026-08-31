import type { Entry } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SWIPE_TARGET_ATTRIBUTE } from "@/hooks/use-swipe-actions";
import { EntryBubble } from "./entry-bubble";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    body: "Ran the loop again this morning.",
    createdAt: "2026-08-27T09:15:00.000Z",
    updatedAt: "2026-08-27T09:15:00.000Z",
    deletedAt: null,
    seq: 1,
    ...overrides,
  } as Entry;
}

function bubbleOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="bubble"]');
  if (!el) throw new Error("no bubble rendered");
  return el;
}

describe("EntryBubble", () => {
  it("renders the Entry's own words", () => {
    render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    expect(screen.getByText("Ran the loop again this morning.")).toBeInTheDocument();
  });

  // The defect treatment F left behind: with both sides full width and told
  // apart only by a tint, a Question and its Answer are hard to scan apart.
  it("insets each side from the opposite edge, so the two are told apart by position", () => {
    const { container: out } = render(
      <EntryBubble entry={entry()} syncEnabled={false} side="out" />,
    );
    expect(bubbleOf(out).className).toContain("justify-end");
    expect(bubbleOf(out).className).toContain("pl-[12%]");

    const { container: incoming } = render(
      <EntryBubble entry={entry({ id: "e2" })} syncEnabled={false} side="in" />,
    );
    expect(bubbleOf(incoming).className).toContain("justify-start");
    expect(bubbleOf(incoming).className).toContain("pr-[12%]");
  });

  it("marks its side for anything styling or asserting against it", () => {
    const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="in" />);

    expect(bubbleOf(container)).toHaveAttribute("data-side", "in");
  });

  // A run of bubbles from one side reads as one turn of writing; a change of
  // side is the boundary worth spacing apart.
  it("groups tightly against the bubble above it, and loosely when it starts a run", () => {
    const { container: grouped } = render(
      <EntryBubble entry={entry()} syncEnabled={false} side="out" groupedWithPrevious />,
    );
    expect(bubbleOf(grouped).className).toContain("mt-0.5");

    const { container: fresh } = render(
      <EntryBubble entry={entry({ id: "e3" })} syncEnabled={false} side="out" />,
    );
    expect(bubbleOf(fresh).className).toContain("mt-3");
  });

  // Issue #149: the clock moved off a right float (which needed the body
  // to stay one line box) onto its own row below it, so an Entry can later
  // hold block content without breaking the float. The meta row is a
  // sibling of the body element, not nested inside it, and right-aligns
  // its own contents rather than relying on float placement to do it.
  it("puts the clock time on its own row below the body, right-aligned", () => {
    const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    // A `<div>`, not `<p>` (issue #152): the body can now render a `<ul>`/
    // `<ol>` alongside its own `<p>`s when the Entry holds a list, and a
    // list cannot validly nest inside a `<p>` — see entry-bubble.tsx's own
    // comment on this element.
    const body = container.querySelector('[data-slot="bubble-body"]');
    expect(body?.tagName).toBe("DIV");

    const meta = container.querySelector("time")?.parentElement;
    expect(meta).not.toBeNull();
    expect(meta?.className).not.toContain("float-right");
    expect(meta?.className).toContain("justify-end");
    // A sibling of the body, not inside it — its own row, not folded into
    // the body's own line box.
    expect(meta?.parentElement).toBe(body?.parentElement);
    expect(body?.contains(meta as Node)).toBe(false);
  });

  it("shows the not-yet-synced marker only when Sync is on and the Entry has not landed", () => {
    const pending = entry({ seq: null });

    const { rerender } = render(<EntryBubble entry={pending} syncEnabled={false} side="out" />);
    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();

    rerender(<EntryBubble entry={pending} syncEnabled={true} side="out" />);
    expect(screen.getByLabelText("Not yet synced")).toBeInTheDocument();

    rerender(<EntryBubble entry={entry({ seq: 4 })} syncEnabled={true} side="out" />);
    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  // Grounding renders Entries too, read-only (CONTEXT.md). A bubble with no
  // actions must offer none rather than offering them disabled.
  it("offers no Edit or Delete when no actions are wired", () => {
    render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  // #127. The marking and the `touch-action` go together: without the
  // attribute the recogniser never picks the bubble up, and without
  // `pan-y` Chromium's own scroll recogniser claims the drag before any
  // handler sees the second move — the same thing `pane-divider.tsx` needs
  // `touch-action: none` for, on the other axis.
  it("marks itself as something a finger can swipe, and leaves the vertical axis to the browser", () => {
    const { container } = render(
      <EntryBubble
        entry={entry({ id: "e7" })}
        syncEnabled={false}
        side="out"
        actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onRefer: vi.fn(), onOpenSheet: vi.fn() }}
      />,
    );

    const target = container.querySelector<HTMLElement>(`[${SWIPE_TARGET_ATTRIBUTE}]`);
    expect(target).not.toBeNull();
    expect(target).toHaveClass("touch-pan-y");
    // The id is how history.tsx turns the element the gesture hands back
    // into the Entry the sheet opens for.
    expect(target?.dataset.entryId).toBe("e7");
  });

  it("marks nothing swipeable when no actions are wired", () => {
    const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    expect(container.querySelector(`[${SWIPE_TARGET_ATTRIBUTE}]`)).toBeNull();
  });

  // Issue #143: history.tsx's own signal that a followed Entry Reference's
  // seek just landed on this row. The flash lives on the fill (the div
  // `bubbleOf`'s first child is — same one `SWIPE_TARGET_ATTRIBUTE` marks
  // above), not the outer wrapper `bubbleOf` itself checks elsewhere in this
  // file, because that's the box with an actual visible edge to ring.
  describe("highlighted", () => {
    it("rings the bubble's fill when highlighted", () => {
      const { container } = render(
        <EntryBubble entry={entry()} syncEnabled={false} side="out" highlighted />,
      );

      expect(bubbleOf(container).firstElementChild).toHaveClass("ring-2");
    });

    it("stays plain, by default, with no seek in flight", () => {
      const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

      expect(bubbleOf(container).firstElementChild).not.toHaveClass("ring-2");
    });
  });
});
