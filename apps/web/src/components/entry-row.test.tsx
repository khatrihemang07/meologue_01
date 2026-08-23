import type { Entry } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as entryDayModule from "@/lib/entry-day";
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

  // Issue #81, fix 3: the absolute timestamp behind this attribute is
  // computed lazily, on hover, rather than for every row on every render —
  // almost no row's tooltip is ever actually shown. No `title` at all
  // before the hover is the observable half of "lazy"; the value appearing
  // after it is the observable half of "still discoverable."
  it("puts a more precise absolute timestamp on hover, computed lazily rather than up front", () => {
    render(
      <EntryRow entry={entry({ createdAt: "2026-08-15T17:27:00.000Z" })} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time).not.toHaveAttribute("title");

    fireEvent.mouseEnter(time);

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

    // Issue #82: Delete no longer deletes on the spot — it merely reports
    // the choice through `onDelete`, exactly like Edit reports through
    // `onEdit` above. Turning that report into a confirmation is the
    // ConfirmDialog history.tsx renders, one level above every row, not
    // anything this component or entry-actions.tsx knows about. EntryRow
    // renders EntryHoverActions but not that dialog, so this only has
    // EntryHoverActions' own contract to prove here; the dialog itself,
    // and onDelete actually firing once it's accepted, are covered by
    // history.test.tsx.
    it("calls onDelete with the whole Entry, to report the choice, when the Delete button is pressed", () => {
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

  // Issue #81, fix 2: History can render hundreds of these, and most of
  // its own re-renders (a sibling row's state changing, a keystroke that
  // doesn't touch this row's Entry) leave a given row's own props
  // untouched — `React.memo` is what lets such a re-render skip this
  // component's own render function (and its call to `formatClockTime`)
  // entirely, rather than re-running it and reconciling unchanged output.
  //
  // `formatClockTime` (imported from entry-day.ts) is what this proves
  // against, rather than a `<Profiler>` wrapping the row: `Profiler`'s
  // `onRender` fires once per *commit that reaches its boundary*, which
  // still happens even when a `React.memo`'d child bails out and never
  // calls its own render function — it isn't actually a signal of whether
  // the row's body ran. A function the row's own body unconditionally
  // calls is.
  describe("memoisation", () => {
    it("does not re-render when a sibling's state changes and this row's own props stay the same", () => {
      const clockSpy = vi.spyOn(entryDayModule, "formatClockTime");
      const target = entry({ body: "hello", createdAt: "2026-08-15T17:27:00.000Z" });

      // Every prop EntryRow gets here is referentially stable across the
      // Harness's own re-renders — `target` is created once, outside the
      // component body — mirroring what history.tsx now guarantees for
      // real rows (memoised `actions`, stable `entry` references from
      // unchanged `groups`).
      function Harness() {
        const [unrelated, setUnrelated] = useState(0);
        return (
          <div>
            <button type="button" onClick={() => setUnrelated((count) => count + 1)}>
              Bump unrelated state
            </button>
            <p data-testid="unrelated">{unrelated}</p>
            <EntryRow entry={target} syncEnabled={false} />
          </div>
        );
      }

      render(<Harness />);
      expect(clockSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Bump unrelated state" }));

      expect(screen.getByTestId("unrelated")).toHaveTextContent("1");
      expect(clockSpy).toHaveBeenCalledTimes(1);
    });

    it("does re-render when its own entry prop actually changes", () => {
      const clockSpy = vi.spyOn(entryDayModule, "formatClockTime");

      function Harness() {
        const [body, setBody] = useState("hello");
        return (
          <div>
            <button type="button" onClick={() => setBody("goodbye")}>
              Change body
            </button>
            <EntryRow
              entry={entry({ body, createdAt: "2026-08-15T17:27:00.000Z" })}
              syncEnabled={false}
            />
          </div>
        );
      }

      render(<Harness />);
      expect(clockSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Change body" }));

      expect(screen.getByText("goodbye")).toBeInTheDocument();
      expect(clockSpy).toHaveBeenCalledTimes(2);
    });
  });
});
