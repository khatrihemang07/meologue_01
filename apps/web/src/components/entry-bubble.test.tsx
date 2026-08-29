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

  // The float is what gives the clock time WhatsApp's behaviour: it sits on
  // the last line when there is room and drops to its own line when there is
  // not, instead of always costing a whole line the way a block does.
  it("floats the clock time so it can share the last line", () => {
    const { container } = render(<EntryBubble entry={entry()} syncEnabled={false} side="out" />);

    const meta = container.querySelector("time")?.parentElement;
    expect(meta?.className).toContain("float-right");
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
        actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onOpenSheet: vi.fn() }}
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
});
