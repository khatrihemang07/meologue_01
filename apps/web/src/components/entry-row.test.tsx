import type { Entry } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryRow } from "./entry-row";

function entry(overrides: Partial<Entry>): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "hello",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

/**
 * Stands in for `matchMedia("(hover: hover)")`, the same idea as
 * `theme.test.ts`'s own `stubMatchMedia` for `(prefers-color-scheme:
 * dark)` — `hoverCapable()` (entry-actions.tsx) only ever reads `.matches`
 * once per call, so this stub needs no `addEventListener` of its own.
 */
function stubHoverCapable(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches, media: query })),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EntryRow", () => {
  it("renders an Entry's body plain when no query is given", () => {
    render(<EntryRow entry={entry({ body: "a recurring task" })} syncEnabled={false} />);

    expect(screen.queryByRole("mark")).not.toBeInTheDocument();
    expect(screen.getByText("a recurring task")).toBeInTheDocument();
  });

  it("highlights the query's match inside an Entry's body", () => {
    render(
      <EntryRow entry={entry({ body: "a recurring task" })} query="recur" syncEnabled={false} />,
    );

    const mark = screen.getByText("recurring", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(mark.parentElement).toHaveTextContent("a recurring task");
  });

  it("shows an Entry's capture time as a clock time, not a date", () => {
    render(
      <EntryRow entry={entry({ createdAt: "2026-08-15T17:27:00.000Z" })} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time.tagName).toBe("TIME");
    expect(time).not.toHaveTextContent(/2026/);
  });

  it("puts a more precise absolute timestamp on hover", () => {
    render(
      <EntryRow entry={entry({ createdAt: "2026-08-15T17:27:00.000Z" })} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time).toHaveAttribute("title", expect.stringMatching(/2026.*:\d{2}:\d{2}\s?(AM|PM)$/i));
  });

  it("renders no time when an Entry's createdAt doesn't parse as a date", () => {
    const { container } = render(
      <EntryRow entry={entry({ createdAt: "now", body: "undated" })} syncEnabled={false} />,
    );

    expect(container.querySelector("time")).not.toBeInTheDocument();
    expect(screen.getByText("undated")).toBeInTheDocument();
  });

  it("marks an unsynced Entry when Sync is on", () => {
    render(<EntryRow entry={entry({ seq: null })} syncEnabled />);

    expect(screen.getByLabelText("Not yet synced")).toBeInTheDocument();
  });

  it("does not mark a synced Entry when Sync is on", () => {
    render(<EntryRow entry={entry({ seq: 3 })} syncEnabled />);

    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  it("marks nothing when Sync is off, even for an unsynced Entry", () => {
    render(<EntryRow entry={entry({ seq: null })} syncEnabled={false} />);

    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  it("defaults to no query when the query prop is omitted entirely", () => {
    render(<EntryRow entry={entry({ body: "a recurring task" })} syncEnabled={false} />);

    expect(screen.queryByRole("mark")).not.toBeInTheDocument();
  });

  // Issue #78: `select-none` is what the old ContextMenuTrigger's
  // `asChild` merged onto this row, and is exactly why Entry text couldn't
  // be dragged to select. Covered for both an action-less row (grounding-
  // disclosure.tsx's shape) and one with actions (history.tsx's), since
  // the class is assembled conditionally.
  describe("text selection", () => {
    it("carries no select-none, with no actions", () => {
      const { container } = render(
        <EntryRow entry={entry({ body: "hello" })} syncEnabled={false} />,
      );

      const row = container.querySelector('[data-slot="entry-row"]');
      expect(row).not.toHaveClass("select-none");
    });

    it("carries no select-none, with actions", () => {
      const { container } = render(
        <EntryRow
          entry={entry({ body: "hello" })}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onOpenSheet: vi.fn() }}
        />,
      );

      const row = container.querySelector('[data-slot="entry-row"]');
      expect(row).not.toHaveClass("select-none");
    });
  });

  // ADR 0028: Edit/Delete are opt-in via `actions`, defaulting to none —
  // see EntryRow's own doc comment on why (grounding-disclosure.test.tsx
  // covers the specific caller this default protects).
  describe("the Edit/Delete actions", () => {
    it("offers no hover buttons when actions is omitted", () => {
      render(<EntryRow entry={entry({ body: "hello" })} syncEnabled={false} />);

      expect(screen.queryByLabelText("Edit")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Delete")).not.toBeInTheDocument();
    });

    it("offers Edit and Delete hover buttons when actions is given", () => {
      render(
        <EntryRow
          entry={entry({ body: "hello" })}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onOpenSheet: vi.fn() }}
        />,
      );

      expect(screen.getByLabelText("Edit")).toBeInTheDocument();
      expect(screen.getByLabelText("Delete")).toBeInTheDocument();
    });

    it("calls onEdit with the whole Entry when the Edit button is pressed", () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit, onDelete, onOpenSheet: vi.fn() }}
        />,
      );

      fireEvent.click(screen.getByLabelText("Edit"));

      expect(onEdit).toHaveBeenCalledWith(target);
      expect(onDelete).not.toHaveBeenCalled();
    });

    it("calls onDelete with the whole Entry when the Delete button is pressed", () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit, onDelete, onOpenSheet: vi.fn() }}
        />,
      );

      fireEvent.click(screen.getByLabelText("Delete"));

      expect(onDelete).toHaveBeenCalledWith(target);
      expect(onEdit).not.toHaveBeenCalled();
    });
  });

  // Issue #78's hover/touch split: a tap opens history.tsx's shared sheet
  // only on a device without hover; a hover-capable device's own inline
  // buttons (covered above) are the entry point there instead, so a plain
  // click on the row body must stay a no-op — otherwise dragging across
  // Entry text to select it on a mouse-equipped device would pop a sheet
  // over the selection the moment the mouse button is released.
  describe("tapping the row", () => {
    it("opens the sheet for this Entry on a device without hover", () => {
      stubHoverCapable(false);
      const onOpenSheet = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onOpenSheet }}
        />,
      );

      fireEvent.click(screen.getByText("hello"));

      expect(onOpenSheet).toHaveBeenCalledWith(target);
    });

    it("does nothing on a hover-capable device", () => {
      stubHoverCapable(true);
      const onOpenSheet = vi.fn();
      render(
        <EntryRow
          entry={entry({ body: "hello" })}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onOpenSheet }}
        />,
      );

      fireEvent.click(screen.getByText("hello"));

      expect(onOpenSheet).not.toHaveBeenCalled();
    });

    it("does nothing when actions is omitted", () => {
      stubHoverCapable(false);
      render(<EntryRow entry={entry({ body: "hello" })} syncEnabled={false} />);

      // No onOpenSheet to spy on with no actions — this only asserts a
      // click doesn't throw with nothing wired up.
      expect(() => fireEvent.click(screen.getByText("hello"))).not.toThrow();
    });
  });

  // The optional half of the ticket: right-click may open the same sheet
  // on a pointer device, but must never intercept a touch device's
  // long-press — which is what actually starts native text selection —
  // by calling preventDefault on it.
  describe("right-clicking the row (optional, pointer devices)", () => {
    it("opens the sheet and prevents the native menu on a hover-capable device", () => {
      stubHoverCapable(true);
      const onOpenSheet = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <EntryRow
          entry={target}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onOpenSheet }}
        />,
      );

      const notPrevented = fireEvent.contextMenu(screen.getByText("hello"));

      expect(onOpenSheet).toHaveBeenCalledWith(target);
      expect(notPrevented).toBe(false);
    });

    it("leaves a touch device's contextmenu (long-press) alone entirely", () => {
      stubHoverCapable(false);
      const onOpenSheet = vi.fn();
      render(
        <EntryRow
          entry={entry({ body: "hello" })}
          syncEnabled={false}
          actions={{ onEdit: vi.fn(), onDelete: vi.fn(), onOpenSheet }}
        />,
      );

      const notPrevented = fireEvent.contextMenu(screen.getByText("hello"));

      expect(onOpenSheet).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    });
  });
});
