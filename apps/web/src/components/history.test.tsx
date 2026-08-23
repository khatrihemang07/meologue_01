import type { Entry } from "@meologue/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as entryDayModule from "@/lib/entry-day";
import { History } from "./history";

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

// Pins "now" and the Device's UTC offset for the grouping/separator tests
// below (ticket 52) — without this, "Today" vs "Yesterday" and which
// calendar day a UTC instant falls on would depend on whichever host and
// timezone happens to run the suite.
function pinClock(nowIso: string, offsetMinutes = 0) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(nowIso));
  vi.spyOn(entryDayModule, "deviceUtcOffsetMinutes").mockReturnValue(offsetMinutes);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * See entry-day.test.ts's own copy of this helper for why a bare
 * `vi.spyOn(Intl, "DateTimeFormat")` isn't enough: it swaps in a mock whose
 * `new` produces an object missing the native class's internal formatting
 * slots, so `.format()` on it throws. Forwarding to the real constructor
 * via `Reflect.construct` keeps formatters genuinely functional while
 * still counting how many actually got built.
 */
function spyOnDateTimeFormatConstructor() {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  // biome-ignore lint/complexity/useArrowFunction: must stay a real `function` — vitest's mock only treats a `function`/`class`-shaped implementation as constructable, and `new Intl.DateTimeFormat(...)` in the code under test needs that.
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: unknown[]) {
    return Reflect.construct(OriginalDateTimeFormat, args);
  } as unknown as typeof Intl.DateTimeFormat);
}

describe("History", () => {
  it("shows an Entry's capture time as a clock time, not a date", () => {
    render(
      <History entries={[entry({ createdAt: "2026-08-15T17:27:00.000Z" })]} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time.tagName).toBe("TIME");
    expect(time).not.toHaveTextContent(/2026/);
  });

  // Issue #81: the absolute timestamp behind this attribute is now computed
  // lazily, on hover, rather than for every row on every render (see
  // entry-row.tsx's own comment) — so this asserts it only after the same
  // hover a real reader would need before ever seeing the tooltip.
  it("puts a more precise absolute timestamp on hover", () => {
    render(
      <History entries={[entry({ createdAt: "2026-08-15T17:27:00.000Z" })]} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time).not.toHaveAttribute("title");

    fireEvent.mouseEnter(time);

    expect(time).toHaveAttribute("title", expect.stringMatching(/2026.*:\d{2}:\d{2}\s?(AM|PM)$/i));
  });

  it("renders an Entry without a time or day separator when its createdAt doesn't parse as a date", () => {
    const { container } = render(
      <History entries={[entry({ createdAt: "now", body: "undated" })]} syncEnabled={false} />,
    );

    expect(container.querySelector("time")).not.toBeInTheDocument();
    expect(screen.getByText("undated")).toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
    expect(screen.queryByText("Yesterday")).not.toBeInTheDocument();
  });

  it("marks an unsynced Entry when Sync is on", () => {
    render(<History entries={[entry({ seq: null })]} syncEnabled />);

    expect(screen.getByLabelText("Not yet synced")).toBeInTheDocument();
  });

  it("does not mark a synced Entry when Sync is on", () => {
    render(<History entries={[entry({ seq: 3 })]} syncEnabled />);

    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  it("marks nothing when Sync is off, even for an unsynced Entry", () => {
    render(<History entries={[entry({ seq: null })]} syncEnabled={false} />);

    expect(screen.queryByLabelText("Not yet synced")).not.toBeInTheDocument();
  });

  it("renders Entry bodies plain when no query is given", () => {
    render(<History entries={[entry({ body: "a recurring task" })]} syncEnabled={false} />);

    expect(screen.queryByRole("mark")).not.toBeInTheDocument();
    expect(screen.getByText("a recurring task")).toBeInTheDocument();
  });

  it("highlights the query's match inside an Entry's body", () => {
    render(
      <History entries={[entry({ body: "a recurring task" })]} syncEnabled={false} query="recur" />,
    );

    const mark = screen.getByText("recurring", { selector: "mark" });
    expect(mark).toBeInTheDocument();
    expect(mark.parentElement).toHaveTextContent("a recurring task");
  });

  it("shows a not-found message, distinct from the empty-History message, once a search matches nothing", () => {
    render(<History entries={[]} syncEnabled={false} query="nothing matches this" />);

    expect(screen.getByText("No matching Entries.")).toBeInTheDocument();
    expect(screen.queryByText("History will appear here.")).not.toBeInTheDocument();
  });

  it("shows the usual empty-History message when there is no query", () => {
    render(<History entries={[]} syncEnabled={false} />);

    expect(screen.getByText("History will appear here.")).toBeInTheDocument();
  });

  it("groups Entries by local day, one separator per day, in the order received", () => {
    pinClock("2026-08-18T12:00:00.000Z");

    // Deliberately newest-first, matching what list() (ORDER BY created_at
    // DESC) actually hands History — grouping must not reorder these;
    // reversing to oldest-first reading order is ticket 53's job.
    const e1 = entry({ id: "1", body: "first", createdAt: "2026-08-18T15:00:00.000Z" });
    const e2 = entry({ id: "2", body: "second", createdAt: "2026-08-18T09:00:00.000Z" });
    const e3 = entry({ id: "3", body: "third", createdAt: "2026-08-17T20:00:00.000Z" });
    const e4 = entry({ id: "4", body: "fourth", createdAt: "2026-08-16T10:00:00.000Z" });

    const { container } = render(<History entries={[e1, e2, e3, e4]} syncEnabled={false} />);

    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText(/August 16/)).toBeInTheDocument();

    const bodies = Array.from(container.querySelectorAll("p")).map((p) => p.textContent);
    expect(bodies).toEqual(["first", "second", "third", "fourth"]);
  });

  it("puts the full weekday and date on the day separator, for hover", () => {
    pinClock("2026-08-18T12:00:00.000Z");

    render(
      <History entries={[entry({ createdAt: "2026-08-18T15:00:00.000Z" })]} syncEnabled={false} />,
    );

    expect(screen.getByText("Today")).toHaveAttribute("title", expect.stringMatching(/2026/));
  });

  /** Same stand-in as entry-row.test.tsx's — see its own comment. */
  function stubHoverCapable(matches: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches, media: query })),
    );
  }

  // ADR 0028 (issue #78): History assembles EntryRow's `actions` — and the
  // single shared EntryActionsSheet's open/closed state — from its own
  // onEdit and onDelete props, both or neither, never one alone (see the
  // props' own comment). Both-present is exercised end to end by
  // composer-page.test.tsx; this pins down the gating itself, including
  // the intentionally-unhandled "only one given" case, plus the
  // one-sheet-however-many-rows property, at this component's own level.
  describe("the Edit/Delete actions", () => {
    it("wires no hover buttons or sheet when neither onEdit nor onDelete is given", () => {
      stubHoverCapable(false);
      render(<History entries={[entry({ body: "hello" })]} syncEnabled={false} />);

      fireEvent.click(screen.getByText("hello"));

      expect(screen.queryByLabelText("Edit")).not.toBeInTheDocument();
      expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    });

    it("wires nothing when only one of onEdit/onDelete is given", () => {
      stubHoverCapable(false);
      render(<History entries={[entry({ body: "hello" })]} syncEnabled={false} onEdit={vi.fn()} />);

      fireEvent.click(screen.getByText("hello"));

      expect(screen.queryByLabelText("Edit")).not.toBeInTheDocument();
      expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    });

    it("wires hover Edit/Delete buttons onto every row when both are given", () => {
      render(
        <History
          entries={[entry({ id: "1", body: "first" }), entry({ id: "2", body: "second" })]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      expect(screen.getAllByLabelText("Edit")).toHaveLength(2);
      expect(screen.getAllByLabelText("Delete")).toHaveLength(2);
    });

    it("opens the shared sheet for the tapped row's Entry on a touch device", () => {
      stubHoverCapable(false);
      render(
        <History
          entries={[entry({ body: "hello" })]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByText("hello"));

      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    it("calls onEdit with the whole Entry through the sheet", () => {
      stubHoverCapable(false);
      const onEdit = vi.fn();
      const target = entry({ body: "hello" });
      render(<History entries={[target]} syncEnabled={false} onEdit={onEdit} onDelete={vi.fn()} />);

      fireEvent.click(screen.getByText("hello"));
      fireEvent.click(screen.getByText("Edit"));

      expect(onEdit).toHaveBeenCalledWith(target);
    });

    // Issue #82: choosing Delete in the sheet no longer fires onDelete on
    // the spot — it closes the sheet and opens the confirm dialog History
    // owns (see history.tsx's own `confirmEntry` comment); onDelete only
    // fires once that's accepted. The dialog's own behaviour (confirm,
    // Cancel, Escape, outside click, focus) is covered by the "delete
    // confirmation" describe block below.
    it("calls onDelete with the whole Entry once the delete confirmation is accepted", async () => {
      stubHoverCapable(false);
      const onDelete = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <History entries={[target]} syncEnabled={false} onEdit={vi.fn()} onDelete={onDelete} />,
      );

      fireEvent.click(screen.getByText("hello"));
      fireEvent.click(screen.getByText("Delete"));

      expect(onDelete).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(onDelete).toHaveBeenCalledWith(target);
    });

    // The property issue #78 exists to establish: no matter how many
    // Entries are rendered, there is exactly one sheet in the DOM — never
    // one per row (that was the old ContextMenu's per-row cost, just
    // moved to a different primitive).
    it("keeps exactly one sheet instance no matter how many rows are tapped", () => {
      stubHoverCapable(false);
      const e1 = entry({ id: "1", body: "first" });
      const e2 = entry({ id: "2", body: "second" });
      const e3 = entry({ id: "3", body: "third" });
      render(
        <History entries={[e1, e2, e3]} syncEnabled={false} onEdit={vi.fn()} onDelete={vi.fn()} />,
      );

      expect(screen.queryAllByRole("dialog")).toHaveLength(0);

      fireEvent.click(screen.getByText("first"));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);

      fireEvent.click(screen.getByText("second"));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);

      fireEvent.click(screen.getByText("third"));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });
  });

  // Issue #82: the confirm dialog moved here from entry-actions.tsx — it
  // used to be a module-scoped Zustand store (`useDeleteConfirm`) that
  // `EntryActionsSheet` mounted itself, a workaround for a file-ownership
  // restriction rather than a design choice. `history.tsx` already owned
  // exactly the right shared state (`sheetEntry`, just above) for this:
  // one component above every row, so `confirmEntry` lives beside it and
  // the single `ConfirmDialog` below serves every row the same way the
  // single `EntryActionsSheet` above does. These tests used to drive the
  // dialog directly through that store; now they drive it the same way a
  // real reader would, through a rendered `<History>`.
  describe("delete confirmation (issue #82)", () => {
    // Opens the dialog through a row's hover Delete button — simpler than
    // going through the touch sheet (which itself closes the instant
    // Delete is pressed, per the test above) and exercises the same
    // `onDelete` -> `setConfirmEntry` wiring either entry point shares.
    function openConfirmDialog(onDelete = vi.fn()) {
      const target = entry({ id: "7", body: "hello" });
      render(
        <History entries={[target]} syncEnabled={false} onEdit={vi.fn()} onDelete={onDelete} />,
      );
      fireEvent.click(screen.getByLabelText("Delete"));
      return { onDelete, target };
    }

    it("shows a confirm dialog, not an immediate delete, once Delete is chosen", async () => {
      const { onDelete } = openConfirmDialog();

      const dialog = await screen.findByRole("alertdialog");

      expect(dialog).toBeInTheDocument();
      expect(onDelete).not.toHaveBeenCalled();
    });

    it("confirming calls onDelete with the Entry and closes the dialog", async () => {
      const { onDelete, target } = openConfirmDialog();
      await screen.findByRole("alertdialog");

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      expect(onDelete).toHaveBeenCalledWith(target);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("Cancel closes the dialog without calling onDelete, leaving the Entry alone", async () => {
      const { onDelete } = openConfirmDialog();
      await screen.findByRole("alertdialog");

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onDelete).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("Escape closes the dialog without calling onDelete, leaving the Entry alone", async () => {
      const { onDelete } = openConfirmDialog();
      await screen.findByRole("alertdialog");

      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

      expect(onDelete).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("dismissing by clicking outside closes the dialog without calling onDelete", async () => {
      const { onDelete } = openConfirmDialog();
      await screen.findByRole("alertdialog");

      // Radix's overlay sits behind the dialog content and covers the rest
      // of the page — a pointerdown (then click) on it is what an "outside
      // click" actually is, not a click on `document.body` itself (which
      // has no overlay listener of its own to catch it). Radix's
      // dismissable layer captures the pointerdown to know an outside
      // interaction started, but only actually dismisses on the `click`
      // that follows it — a real pointer/mouse interaction always fires
      // both; a bare `pointerDown` alone (jsdom doesn't synthesize the
      // follow-up click the way a real browser would) is not enough to
      // trigger it here.
      const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]');
      expect(overlay).not.toBeNull();
      if (overlay) {
        fireEvent.pointerDown(overlay);
        fireEvent.click(overlay);
      }

      expect(onDelete).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("is keyboard-navigable and focus-trapped: opening it moves focus inside, and both actions are reachable", async () => {
      openConfirmDialog();

      const dialog = await screen.findByRole("alertdialog");

      // Radix's FocusScope moves focus into the Content the moment it
      // mounts (part of what makes this "keyboard-navigable" rather than
      // requiring a mouse to reach) — this is what a focus trap depends on
      // to keep working at all: nothing outside `dialog` to tab back out
      // to.
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      const confirmButton = screen.getByRole("button", { name: "Delete" });
      expect(dialog).toContainElement(cancelButton);
      expect(dialog).toContainElement(confirmButton);
    });

    it("marks the confirm action as the destructive one, distinct from Cancel", async () => {
      openConfirmDialog();
      await screen.findByRole("alertdialog");

      const confirmButton = screen.getByRole("button", { name: "Delete" });
      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      expect(confirmButton).toHaveAttribute("data-variant", "destructive");
      expect(cancelButton).not.toHaveAttribute("data-variant", "destructive");
    });

    // The same property the sheet's own test above establishes, for the
    // dialog: no matter how many rows are rendered, there is exactly one
    // ConfirmDialog in the DOM — never one per row.
    it("keeps exactly one confirm dialog instance no matter which row's Delete is chosen", () => {
      const e1 = entry({ id: "1", body: "first" });
      const e2 = entry({ id: "2", body: "second" });
      const e3 = entry({ id: "3", body: "third" });
      render(
        <History entries={[e1, e2, e3]} syncEnabled={false} onEdit={vi.fn()} onDelete={vi.fn()} />,
      );

      expect(screen.queryAllByRole("alertdialog")).toHaveLength(0);

      const deleteButtons = screen.getAllByLabelText("Delete");
      expect(deleteButtons).toHaveLength(3);
      const [firstDelete, secondDelete, thirdDelete] = deleteButtons as [
        HTMLElement,
        HTMLElement,
        HTMLElement,
      ];

      fireEvent.click(firstDelete);
      expect(screen.getAllByRole("alertdialog")).toHaveLength(1);

      fireEvent.click(secondDelete);
      expect(screen.getAllByRole("alertdialog")).toHaveLength(1);

      fireEvent.click(thirdDelete);
      expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    });
  });

  // Issue #81, fix 4: `groupByDay` is the one genuinely O(entries.length)
  // piece of History's render-body work, so it's memoised on `entries`
  // (see history.tsx's own comment on why `deviceUtcOffsetMinutes`/
  // `entryDayKey`'s *other* render-body call, for `todayKey`, stays
  // un-memoised deliberately). `entryDayKey` is called once per Entry
  // inside `groupByDay`, plus once more directly for `todayKey` — so a
  // render that changes something grouping doesn't depend on (`query`)
  // should add exactly one more call, not `entries.length + 1` again.
  it("memoises day grouping so a render triggered by an unrelated prop doesn't re-walk the Entries", () => {
    pinClock("2026-08-18T12:00:00.000Z");
    const spy = vi.spyOn(entryDayModule, "entryDayKey");
    const entries = [
      entry({ id: "1", body: "first", createdAt: "2026-08-18T15:00:00.000Z" }),
      entry({ id: "2", body: "second", createdAt: "2026-08-18T09:00:00.000Z" }),
      entry({ id: "3", body: "third", createdAt: "2026-08-17T20:00:00.000Z" }),
    ];

    const { rerender } = render(<History entries={entries} syncEnabled={false} />);
    // Once for todayKey, once per Entry inside groupByDay.
    expect(spy).toHaveBeenCalledTimes(1 + entries.length);

    // Same `entries` reference, only `query` (grouping-irrelevant) changes.
    rerender(<History entries={entries} syncEnabled={false} query="fir" />);

    expect(spy).toHaveBeenCalledTimes(1 + entries.length + 1);
  });

  // Issue #81, fix 1: formatDaySeparatorTitle's own `Intl.DateTimeFormat`
  // (its options are fixed — always `{ dateStyle: "full", timeZone: "UTC"
  // }` — so a single cached instance covers every day separator, unlike
  // entry-day.ts's formatDaySeparator next to it) must not be rebuilt per
  // separator. A dynamic re-import gives this test a module instance whose
  // formatter cache hasn't already been warmed by an earlier test in this
  // file, so a regression can't hide behind test order.
  //
  // The assertion compares *before* vs *after* adding two more separators
  // (and two more rows' clock times), rather than asserting a single fixed
  // total call count: a render here also builds entry-day.ts's own clock
  // and day-separator formatters (already covered by entry-day.test.ts),
  // and coupling this test to their exact count too would make it fail for
  // reasons that have nothing to do with formatDaySeparatorTitle. What
  // this test owns is specifically "more separators must not mean more
  // Intl.DateTimeFormat construction" — true only if every formatter
  // involved, this one included, is actually cached.
  it("reuses one day-separator-title formatter across many separators, not one per separator", async () => {
    vi.resetModules();
    const { History: FreshHistory } = await import("./history");
    const spy = spyOnDateTimeFormatConstructor();

    const { rerender } = render(
      <FreshHistory
        entries={[entry({ id: "1", body: "first", createdAt: "2020-01-01T12:00:00.000Z" })]}
        syncEnabled={false}
      />,
    );
    const callsForOneSeparator = spy.mock.calls.length;

    rerender(
      <FreshHistory
        entries={[
          entry({ id: "1", body: "first", createdAt: "2020-01-01T12:00:00.000Z" }),
          entry({ id: "2", body: "second", createdAt: "2021-06-15T12:00:00.000Z" }),
          entry({ id: "3", body: "third", createdAt: "2022-11-30T12:00:00.000Z" }),
        ]}
        syncEnabled={false}
      />,
    );

    expect(screen.getAllByText(/^(first|second|third)$/)).toHaveLength(3);
    expect(spy.mock.calls.length).toBe(callsForOneSeparator);
  });
});
