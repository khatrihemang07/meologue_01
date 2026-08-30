import type { Entry } from "@meologue/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  type RenderOptions,
  type RenderResult,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";
import * as entryDayModule from "@/lib/entry-day";
import { dayReferrersQueryKey } from "@/lib/query-keys";
import { swipeLeft, tap } from "@/test/swipe";
import { History } from "./history";

// Issue #146: History now calls `useNavigate()` (confirming a date picked
// from either day marker), which throws outside a Router. Every render in
// this file goes through this wrapper instead of `@testing-library/react`'s
// own `render` directly, rather than touching each of the dozens of
// existing call sites below: RTL's `wrapper` option applies to `rerender`
// too (its own docs), so a `rerender(...)` call further down a test stays
// wrapped in the same `MemoryRouter` its initial `render` was, with no
// change needed at either call site.
//
// Issue #147: `DayReferrersRow` is now unconditionally part of `flatItems`
// (one per day separator, regardless of what any test's fixtures put in an
// Entry's body), and it calls `useDayReferrers`, which calls `useQuery` —
// unlike `DateReferenceLink`/`EntryReferenceLink`, whose own `useQuery`
// calls only ever ran for a test that actually put a `[[...]]` mark in a
// body. Every render in this file now needs a `QueryClient` in scope for
// that reason alone, not because any given test cares about Referrers — a
// fresh one per `render()` call, same as entry-row.test.tsx's own harness,
// so a query cached in one test can't leak into the next.
function render(ui: ReactElement, options?: RenderOptions): RenderResult {
  const queryClient = new QueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

// Copy's two outcomes are the whole point of it reporting rather than
// acting (#127), so both the clipboard and the toaster are stand-ins here:
// jsdom has no clipboard worth exercising, and `<Toaster />` is mounted by
// App, not by History.
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

    const bodies = Array.from(container.querySelectorAll('[data-slot="bubble-body"]')).map(
      (p) => p.textContent,
    );
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

    // Issue #144: Refer joins onEdit/onDelete under the same all-or-nothing
    // rule (history.tsx's own `actions` comment) rather than being a fourth,
    // independently-optional prop — a caller with onEdit/onDelete but no
    // onRefer is exactly as unwired as one missing onDelete alone, above.
    it("wires nothing when onEdit and onDelete are given but onRefer is missing", () => {
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
          onRefer={vi.fn()}
        />,
      );

      expect(screen.getAllByLabelText("Edit")).toHaveLength(2);
      expect(screen.getAllByLabelText("Delete")).toHaveLength(2);
      expect(screen.getAllByLabelText("Refer to this Entry")).toHaveLength(2);
    });

    // #127: a leftward swipe is what reaches the sheet on touch now, not a
    // tap. A tap does nothing, which is what leaves it free to place a
    // cursor or dismiss a selection.
    it("opens the shared sheet for the swiped row's Entry on a touch device", () => {
      stubHoverCapable(false);
      render(
        <History
          entries={[entry({ body: "hello" })]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRefer={vi.fn()}
        />,
      );

      swipeLeft(screen.getByText("hello"));

      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Copy")).toBeInTheDocument();
      expect(screen.getByText("Refer to this Entry")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    it("leaves the sheet shut for a tap", () => {
      stubHoverCapable(false);
      render(
        <History
          entries={[entry({ body: "hello" })]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRefer={vi.fn()}
        />,
      );

      tap(screen.getByText("hello"));

      expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    });

    // Issue #144's own acceptance criterion: right-click on a hover-capable
    // device reaches the same sheet a touch device's swipe does, Refer
    // included — entry-row.test.tsx already pins down `handleRowContextMenu`
    // itself (calling `onOpenSheet`, and leaving a touch device's long-press
    // alone entirely); this is the same mechanism exercised end to end
    // through History, the one place the sheet it opens actually lives.
    it("opens the shared sheet, with Refer offered, on right-click on a hover-capable device", () => {
      stubHoverCapable(true);
      render(
        <History
          entries={[entry({ body: "hello" })]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRefer={vi.fn()}
        />,
      );

      fireEvent.contextMenu(screen.getByText("hello"));

      expect(screen.getByText("Edit")).toBeInTheDocument();
      expect(screen.getByText("Copy")).toBeInTheDocument();
      expect(screen.getByText("Refer to this Entry")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    it("calls onEdit with the whole Entry through the sheet", () => {
      stubHoverCapable(false);
      const onEdit = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <History
          entries={[target]}
          syncEnabled={false}
          onEdit={onEdit}
          onDelete={vi.fn()}
          onRefer={vi.fn()}
        />,
      );

      swipeLeft(screen.getByText("hello"));
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
        <History
          entries={[target]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={onDelete}
          onRefer={vi.fn()}
        />,
      );

      swipeLeft(screen.getByText("hello"));
      fireEvent.click(screen.getByText("Delete"));

      expect(onDelete).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(onDelete).toHaveBeenCalledWith(target);
    });

    // The property issue #78 exists to establish: no matter how many
    // Entries are rendered, there is exactly one sheet in the DOM — never
    // one per row (that was the old ContextMenu's per-row cost, just
    // moved to a different primitive).
    it("keeps exactly one sheet instance no matter how many rows are swiped", () => {
      stubHoverCapable(false);
      const e1 = entry({ id: "1", body: "first" });
      const e2 = entry({ id: "2", body: "second" });
      const e3 = entry({ id: "3", body: "third" });
      render(
        <History
          entries={[e1, e2, e3]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRefer={vi.fn()}
        />,
      );

      expect(screen.queryAllByRole("dialog")).toHaveLength(0);

      swipeLeft(screen.getByText("first"));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);

      swipeLeft(screen.getByText("second"));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);

      swipeLeft(screen.getByText("third"));
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
        <History
          entries={[target]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={onDelete}
          onRefer={vi.fn()}
        />,
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
        <History
          entries={[e1, e2, e3]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRefer={vi.fn()}
        />,
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

  // Code review on branch shell-batch: `position: sticky` OCCUPIES FLOW
  // (it isn't `fixed`), so the old `{showOverlayPill && (<div
  // className="sticky ...">)}` mounted and unmounted that wrapper on every
  // flip — changing the height of everything above the bottom-alignment
  // spacer, which this component measures via `spacerRef.current.offsetTop`
  // (its own comment). Past the point History is longer than the viewport
  // that height stops being cancelled out, so every row jumped by about
  // the pill's height each time a day separator scrolled to the top —
  // exactly when `showOverlayPill` flips.
  //
  // jsdom never lays anything out (see history.tsx's own OVERSCAN comment),
  // so `offsetTop` itself is always 0 here and can't stand in for the real
  // regression, and `virtualizer.range` never moves off its initial guess
  // either — meaning the topmost row is always that day's own separator
  // and `showOverlayPill` is always the *hidden* case (its own comment).
  // What this asserts instead is the structural fix that keeps the real
  // geometry constant: the wrapper renders unconditionally — only the
  // inner `<span>`'s visibility toggles — so there is always exactly one
  // element between the top of History and the spacer, never zero.
  it("keeps the day pill's sticky wrapper mounted (never removed from flow) even while the pill itself is hidden", () => {
    const { container } = render(
      <History
        entries={[entry({ id: "1", body: "first", createdAt: "2026-08-18T15:00:00.000Z" })]}
        syncEnabled={false}
      />,
    );

    const spacer = container.querySelector('[aria-hidden="true"]');
    expect(spacer).not.toBeNull();
    // The pill wrapper is the spacer's immediately preceding sibling — the
    // one thing history.tsx measures itself as "content above the list"
    // (its own `contentAboveList` comment).
    const pillWrapper = spacer?.previousElementSibling;
    expect(pillWrapper).toHaveClass("sticky");

    // Issue #146: a `<button>` now, not a `<span>` — see history.tsx's own
    // comment on the button by the wrapper's own `h-9` for why that
    // conversion doesn't touch this wrapper's height.
    const pillLabel = pillWrapper?.querySelector("button");
    expect(pillLabel).not.toBeNull();
    expect(pillLabel).toHaveClass("invisible");
    // Withheld, not just visually hidden — see history.tsx's own comment
    // on why an `invisible` button still carrying the day label would
    // duplicate the inline separator's own text.
    expect(pillLabel).toHaveTextContent("");
  });

  // Code review on branch shell-batch: the zero-viewport fallback used to
  // map every one of `flatItems` — the exact per-row DOM cost issue #83
  // exists to remove, paid on a real History's very first paint (before
  // its first ResizeObserver callback lands), not just under jsdom. This
  // pins down that a large History renders a bounded number of rows, not
  // one per Entry, whenever there's no sized scroll element to virtualize
  // against — jsdom's own case here, and this stands in for a real
  // browser's first paint too, since both reach the fallback the same way
  // (history.tsx's own comment on `hasSizedScrollElement`).
  // #127: Copy lives here for the same reason Delete's confirmation does —
  // this is the one component above every row. It has to distinguish its
  // outcomes, because a WebView that refused the clipboard and one that
  // wrote to it are indistinguishable to the reader until something says
  // so, and they then paste stale text somewhere else and blame that.
  describe("Copy from the actions sheet", () => {
    async function copyFromSheet(outcome: boolean) {
      // The module-level `vi.mock` factories above make these long-lived
      // `vi.fn()`s; the file's own `restoreAllMocks` does not reset them.
      vi.mocked(toast.success).mockClear();
      vi.mocked(toast.error).mockClear();
      stubHoverCapable(false);
      vi.mocked(copyText).mockResolvedValue(outcome);
      const target = entry({ body: "hello" });
      render(
        <History
          entries={[target]}
          syncEnabled={false}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRefer={vi.fn()}
        />,
      );

      swipeLeft(screen.getByText("hello"));
      fireEvent.click(screen.getByText("Copy"));
      await waitFor(() => expect(copyText).toHaveBeenCalled());
      return target;
    }

    it("writes the swiped Entry's own body, and says so", async () => {
      const target = await copyFromSheet(true);

      expect(copyText).toHaveBeenCalledWith(target.body);
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("says something different when the clipboard refused", async () => {
      await copyFromSheet(false);

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  // Issue #144: choosing Refer from the shared sheet puts a Reference to
  // the swiped Entry into the Composer — this pins down that the sheet
  // reports the right Entry through `onRefer` and closes itself; turning
  // that report into an actual insertion is composer-page.tsx's own
  // `handleRefer`, covered end to end by composer-page.test.tsx.
  it("calls onRefer with the whole swiped Entry and closes the sheet when Refer is pressed", () => {
    stubHoverCapable(false);
    const onRefer = vi.fn();
    const target = entry({ body: "hello" });
    render(
      <History
        entries={[target]}
        syncEnabled={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRefer={onRefer}
      />,
    );

    swipeLeft(screen.getByText("hello"));
    fireEvent.click(screen.getByText("Refer to this Entry"));

    expect(onRefer).toHaveBeenCalledWith(target);
    expect(screen.queryByText("Refer to this Entry")).not.toBeInTheDocument();
  });

  it("bounds the zero-viewport fallback to a fixed window instead of rendering the whole History", () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry({ id: String(i), body: `entry-${i}`, createdAt: "2026-08-18T15:00:00.000Z" }),
    );

    render(<History entries={entries} syncEnabled={false} />);

    const rendered = screen.getAllByText(/^entry-\d+$/);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(entries.length);
    expect(rendered.length).toBeLessThanOrEqual(30);
  });

  // Issue #142: a date-Reference seek is "page until you arrive" —
  // History's own half of it (composer-page.tsx owns the pagination
  // decision; see history.tsx's own `onSeekNeedsOlder` comment for why).
  describe("date-Reference seek", () => {
    it("does nothing when no seek is active", () => {
      const onSeekNeedsOlder = vi.fn();
      const onSeekSettled = vi.fn();
      render(
        <History
          entries={[entry({ body: "hello" })]}
          syncEnabled={false}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );

      expect(onSeekNeedsOlder).not.toHaveBeenCalled();
      expect(onSeekSettled).not.toHaveBeenCalled();
    });

    it("asks for an older page when the target day isn't loaded, then finds it and settles once it lands", () => {
      const onSeekNeedsOlder = vi.fn();
      const onSeekSettled = vi.fn();
      const recentEntry = entry({ id: "1", body: "recent", createdAt: "2026-08-18T10:00:00.000Z" });

      const { rerender } = render(
        <History
          entries={[recentEntry]}
          syncEnabled={false}
          seek={{ kind: "day", dayKey: "2020-01-01" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );

      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);
      expect(onSeekSettled).not.toHaveBeenCalled();

      // The older page onSeekNeedsOlder asked for lands, and it holds the
      // target day.
      const olderEntry = entry({ id: "2", body: "older", createdAt: "2020-01-01T10:00:00.000Z" });
      rerender(
        <History
          entries={[recentEntry, olderEntry]}
          syncEnabled={false}
          seek={{ kind: "day", dayKey: "2020-01-01" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );

      expect(onSeekSettled).toHaveBeenCalledTimes(1);
    });

    it("keeps asking across several pages that still don't hold the target day", () => {
      const onSeekNeedsOlder = vi.fn();
      const onSeekSettled = vi.fn();
      const e1 = entry({ id: "1", body: "one", createdAt: "2026-08-18T10:00:00.000Z" });

      const { rerender } = render(
        <History
          entries={[e1]}
          syncEnabled={false}
          seek={{ kind: "day", dayKey: "2020-01-01" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );
      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);

      const e2 = entry({ id: "2", body: "two", createdAt: "2026-08-17T10:00:00.000Z" });
      rerender(
        <History
          entries={[e1, e2]}
          syncEnabled={false}
          seek={{ kind: "day", dayKey: "2020-01-01" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );

      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(2);
      expect(onSeekSettled).not.toHaveBeenCalled();
    });

    // The dedupe property `onSeekNeedsOlder`'s own guard against firing
    // while a fetch is already in flight (composer-page.tsx) depends on:
    // History itself must not re-request just because it re-rendered for an
    // unrelated reason (`query` changing, say) while the same data is still
    // being searched.
    it("does not ask again on a re-render triggered by something unrelated to the Entries available to search", () => {
      const onSeekNeedsOlder = vi.fn();
      const entries = [entry({ id: "1", body: "recent", createdAt: "2026-08-18T10:00:00.000Z" })];

      const { rerender } = render(
        <History
          entries={entries}
          syncEnabled={false}
          seek={{ kind: "day", dayKey: "2020-01-01" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
        />,
      );
      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);

      rerender(
        <History
          entries={entries}
          syncEnabled={false}
          query="rec"
          seek={{ kind: "day", dayKey: "2020-01-01" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
        />,
      );

      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);
    });
  });

  // Issue #143: following an Entry Reference's chip seeks by id rather than
  // by day — same "page until you arrive" convergence as the date-Reference
  // suite just above, mirrored test for test, plus the flash a day seek has
  // no equivalent of.
  describe("Entry-Reference seek", () => {
    it("asks for an older page when the target Entry isn't loaded, then finds it and settles once it lands", () => {
      const onSeekNeedsOlder = vi.fn();
      const onSeekSettled = vi.fn();
      const recentEntry = entry({ id: "1", body: "recent", createdAt: "2026-08-18T10:00:00.000Z" });

      const { rerender } = render(
        <History
          entries={[recentEntry]}
          syncEnabled={false}
          seek={{ kind: "entry", entryId: "2" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );

      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);
      expect(onSeekSettled).not.toHaveBeenCalled();

      const olderEntry = entry({ id: "2", body: "older", createdAt: "2020-01-01T10:00:00.000Z" });
      rerender(
        <History
          entries={[recentEntry, olderEntry]}
          syncEnabled={false}
          seek={{ kind: "entry", entryId: "2" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );

      expect(onSeekSettled).toHaveBeenCalledTimes(1);
    });

    it("keeps asking across several pages that still don't hold the target Entry", () => {
      const onSeekNeedsOlder = vi.fn();
      const onSeekSettled = vi.fn();
      const e1 = entry({ id: "1", body: "one", createdAt: "2026-08-18T10:00:00.000Z" });

      const { rerender } = render(
        <History
          entries={[e1]}
          syncEnabled={false}
          seek={{ kind: "entry", entryId: "missing" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );
      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);

      const e2 = entry({ id: "2", body: "two", createdAt: "2026-08-17T10:00:00.000Z" });
      rerender(
        <History
          entries={[e1, e2]}
          syncEnabled={false}
          seek={{ kind: "entry", entryId: "missing" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
          onSeekSettled={onSeekSettled}
        />,
      );

      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(2);
      expect(onSeekSettled).not.toHaveBeenCalled();
    });

    it("does not ask again on a re-render triggered by something unrelated to the Entries available to search", () => {
      const onSeekNeedsOlder = vi.fn();
      const entries = [entry({ id: "1", body: "recent", createdAt: "2026-08-18T10:00:00.000Z" })];

      const { rerender } = render(
        <History
          entries={entries}
          syncEnabled={false}
          seek={{ kind: "entry", entryId: "missing" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
        />,
      );
      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);

      rerender(
        <History
          entries={entries}
          syncEnabled={false}
          query="rec"
          seek={{ kind: "entry", entryId: "missing" }}
          onSeekNeedsOlder={onSeekNeedsOlder}
        />,
      );

      expect(onSeekNeedsOlder).toHaveBeenCalledTimes(1);
    });

    // Acceptance criterion: "Following one lands on that Entry and marks
    // it." The flash lives on the bubble's fill (entry-bubble.test.tsx's
    // own "highlighted" suite covers that prop in isolation) — this proves
    // History actually drives it, and clears it again on its own timer
    // rather than leaving the row marked forever.
    it("flashes the target bubble once the seek lands on it, then clears the flash on its own", async () => {
      vi.useFakeTimers();
      const target = entry({
        id: "1",
        body: "target entry",
        createdAt: "2026-08-18T10:00:00.000Z",
      });

      render(
        <History entries={[target]} syncEnabled={false} seek={{ kind: "entry", entryId: "1" }} />,
      );

      const fill = screen
        .getByText("target entry")
        .closest('[data-slot="bubble"]')?.firstElementChild;
      expect(fill).toHaveClass("ring-2");

      // SEEK_HIGHLIGHT_DURATION_MS, history.tsx's own private constant —
      // long enough that a reader can register the flash, not so long it
      // reads as a mode the row is stuck in.
      await act(() => vi.advanceTimersByTimeAsync(1500));

      expect(fill).not.toHaveClass("ring-2");
    });
  });

  // Issue #146: both day markers open `DatePickerSheet`, seeded with their
  // own day, and confirming a date seeks History to it exactly the way a
  // date Reference's own chip does (`DateReferenceLink`, entry-row.tsx) —
  // navigating to `/composer?d=YYYY-MM-DD`, read back by composer-page.tsx
  // into the very `seek` prop the suites above already exercise.
  //
  // The sticky pill and the topmost inline separator always name the same
  // day in every test below, by construction (`renderTwoDays`' own
  // comment): jsdom never lays out real scroll geometry, so
  // `virtualizer.range` never moves off its initial guess and the topmost
  // flattened row is always the oldest-loaded day's own separator (see
  // `topmostItem`'s comment in history.tsx). That's also exactly why the
  // pill's own accessible name below never carries a day — `showOverlayPill`
  // is false whenever the topmost row is itself a separator, so the pill
  // stays in its `invisible` state throughout this suite. That state, and
  // the wrapper height ADR 0030 actually protects, is what the e2e spec
  // checks in a real browser instead.
  describe("day markers open a date picker (issue #146)", () => {
    function renderTwoDays() {
      const older = entry({ id: "1", body: "older", createdAt: "2020-01-01T10:00:00.000Z" });
      const newer = entry({ id: "2", body: "newer", createdAt: "2020-01-02T10:00:00.000Z" });
      return render(<History entries={[newer, older]} syncEnabled={false} />);
    }

    it("renders each inline day separator as a button naming its own day, not just a title attribute", () => {
      renderTwoDays();

      const separators = screen.getAllByRole("button", { name: /currently showing/ });
      expect(separators).toHaveLength(2);
      for (const separator of separators) {
        expect(separator.tagName).toBe("BUTTON");
        // `title` stays too (a pointer user's hover tooltip); the
        // accessible name is the new thing this issue adds, not a
        // replacement for it.
        expect(separator).toHaveAttribute("title");
      }
    });

    it("renders the sticky pill as a button too, distinguishable from the separators by its own (dayless) accessible name while hidden", () => {
      renderTwoDays();

      // An exact-string match, not a substring one: the separators' own
      // names both start with this same phrase but continue with
      // "— currently showing <day>" (previous test), so an exact match is
      // what keeps this from also matching either of them.
      const pill = screen.getByRole("button", { name: "Choose a date to jump to" });
      expect(pill.tagName).toBe("BUTTON");
      expect(pill).toHaveClass("invisible");
    });

    it("tapping an inline separator opens the picker seeded with that separator's own day", () => {
      renderTwoDays();

      // `renderTwoDays` (its own comment) puts January 1st's separator
      // second in reading order, distinguishing it from January 2nd's —
      // both are 2020, so the day itself has to disambiguate them here.
      const separator = screen.getByRole("button", {
        name: /currently showing.*January 1, 2020/,
      });
      fireEvent.click(separator);

      // DatePickerSheet seeds `selected` from `initialDate`, and its
      // Confirm button's own label names whatever is currently selected
      // (date-picker-sheet.tsx) — reading that back is what actually
      // proves the day this separator names is what the sheet opened with,
      // rather than just that *a* sheet opened.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      const confirmButton = screen.getByRole("button", { name: /^Confirm/ });
      expect(confirmButton).toHaveTextContent("January 1, 2020");
    });

    it("tapping the sticky pill opens the picker seeded with the topmost day, even while the pill itself is hidden", () => {
      renderTwoDays();

      // The pill is `invisible` (its own comment), not `disabled` — a real
      // pointer/keyboard user can never reach it in this state, but
      // nothing about the click handler itself depends on that CSS state
      // (history.tsx's own comment on why), so a direct `fireEvent.click`
      // here is exercising the same handler a visible pill would use once
      // scrolled to, in a real browser, exactly to that position.
      const pill = screen.getByRole("button", { name: "Choose a date to jump to" });
      fireEvent.click(pill);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // The topmost loaded day here is 2020-01-02 (`renderTwoDays`'s own
      // comment: the oldest-loaded day's separator is always the topmost
      // row under jsdom).
      expect(screen.getByRole("button", { name: /^Confirm/ })).toHaveTextContent("January 2, 2020");
    });

    it("does not call onConfirm just from tapping a marker — the sheet's own tap-then-confirm still applies", () => {
      renderTwoDays();

      // Either separator does for this one — which day opened it isn't
      // the point here.
      const [firstSeparator] = screen.getAllByRole("button", {
        name: /currently showing/,
      }) as [HTMLElement, HTMLElement];
      fireEvent.click(firstSeparator);
      // Dismissing without pressing Confirm must not have navigated
      // anywhere — checked properly by the "confirming navigates" test
      // below; here it's enough that dismissing leaves the History page
      // still mounted with nothing thrown, since DatePickerSheet's own
      // suite already covers "tap alone never calls onConfirm" in isolation.
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("is keyboard operable: a native <button>, focusable, and activated by the same click a real browser's Enter/Space resolves to", () => {
      renderTwoDays();

      // Either separator does for this one, same as the test above.
      const [separator] = screen.getAllByRole("button", {
        name: /currently showing/,
      }) as [HTMLElement, HTMLElement];
      // A native, unstyled `<button>` is exactly what makes Tab-then-Enter/
      // Space work with no code of this component's own — every browser
      // wires that up for a real `<button>` element, and jsdom itself has
      // no such default action to fake here (confirmed against jsdom
      // directly: dispatching a `keydown`/`keyup` with `key: "Enter"` or
      // `" "` at a plain `<button>` fires no `click`). What a unit test
      // *can* pin down is the two things that guarantee, rather than merely
      // hope, that a keyboard reaches this control at all: it is a real
      // `<button>` (not a `<span>`/`<div role="button">`, which would need
      // its own keydown handling this component doesn't have), and it is
      // actually focusable.
      expect(separator.tagName).toBe("BUTTON");
      expect(separator).not.toHaveAttribute("tabindex", "-1");
      separator.focus();
      expect(separator).toHaveFocus();

      fireEvent.click(separator);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("confirming a picked date navigates to /composer?d=YYYY-MM-DD — the exact route a date Reference's own chip uses", () => {
      function LocationDisplay() {
        const location = useLocation();
        return <div data-testid="location">{location.pathname + location.search}</div>;
      }
      const older = entry({ id: "1", body: "older", createdAt: "2020-01-01T10:00:00.000Z" });
      // Bypasses this file's own `render` wrapper (needs a sibling
      // `<LocationDisplay>` outside `<History>`), so it needs its own
      // `QueryClient` for the same reason that wrapper's own comment
      // gives: `DayReferrersRow`'s `useDayReferrers` call is unconditional.
      rtlRender(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <History entries={[older]} syncEnabled={false} />
            <LocationDisplay />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: /currently showing/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));

      expect(screen.getByTestId("location")).toHaveTextContent("/composer?d=2020-01-01");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  // Issue #147: "a day shows what Refers to it" (ADR 0042's own Context) —
  // `DayReferrersRow`'s own suite. `dayReferrers` here is a bare stub, the
  // same shape use-day-referrers.test.tsx's own harness uses — this level
  // only cares that History wires the prop into the right row and renders
  // (or withholds) the right thing, not that the real probe's own
  // search-then-parse logic is correct (day-referrers.test.ts owns that).
  describe("day Referrers (issue #147)", () => {
    function referrer(overrides: Partial<Entry> = {}): Entry {
      return entry({
        id: "referrer-1",
        body: "circling back to [[2026-08-28]]",
        createdAt: "2026-08-29T09:00:00.000Z",
        ...overrides,
      });
    }

    it("shows how many later Entries Refer to a day, and lets the reader open one", async () => {
      const dayReferrers = vi.fn(async (key: string) => (key === "2026-08-28" ? [referrer()] : []));
      render(
        <History
          entries={[
            entry({ id: "1", body: "the day itself", createdAt: "2026-08-28T10:00:00.000Z" }),
          ]}
          syncEnabled={false}
          dayReferrers={dayReferrers}
        />,
      );

      expect(await screen.findByText("Referred to by 1 Entry:")).toBeInTheDocument();
      const link = screen.getByRole("link", { name: /that Refers to this day/ });
      expect(link).toHaveAttribute("href", "/composer?e=referrer-1");
      expect(dayReferrers).toHaveBeenCalledWith("2026-08-28");
    });

    it("shows every referrer, pluralised, when more than one Entry Refers to the day", async () => {
      const dayReferrers = vi.fn(async () => [
        referrer({ id: "a" }),
        referrer({ id: "b", body: "also about [[2026-08-28]]" }),
      ]);
      render(
        <History
          entries={[entry({ id: "1", createdAt: "2026-08-28T10:00:00.000Z" })]}
          syncEnabled={false}
          dayReferrers={dayReferrers}
        />,
      );

      expect(await screen.findByText("Referred to by 2 Entries:")).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: /that Refers to this day/ })).toHaveLength(2);
    });

    // The acceptance criterion this whole suite exists to pin down: no
    // empty state, no zero count, nothing rendered at all.
    it("shows nothing at all for a day nothing Refers to", async () => {
      const dayReferrers = vi.fn(async () => []);
      render(
        <History
          entries={[entry({ id: "1", createdAt: "2026-08-28T10:00:00.000Z" })]}
          syncEnabled={false}
          dayReferrers={dayReferrers}
        />,
      );

      await waitFor(() => expect(dayReferrers).toHaveBeenCalledWith("2026-08-28"));
      expect(screen.queryByText(/Referred to by/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /that Refers to this day/ }),
      ).not.toBeInTheDocument();
    });

    // The same "no probe is the same as still resolving" rule every sibling
    // Reference hook already follows (`useDayHasEntries`, `useEntryReference`)
    // — a page with no reason to know this feature exists simply omits the
    // prop, and every day renders as if nothing Refers to it.
    it("shows nothing when no dayReferrers probe is supplied at all", () => {
      render(
        <History
          entries={[entry({ id: "1", createdAt: "2026-08-28T10:00:00.000Z" })]}
          syncEnabled={false}
        />,
      );

      expect(screen.queryByText(/Referred to by/)).not.toBeInTheDocument();
    });

    // Removing (or editing away) the one Entry that Referred to a day shows
    // up here as exactly what a real removal produces downstream: the same
    // query key (`dayReferrersQueryKey`) invalidated, and the probe now
    // resolving to fewer Entries — entries-pagination.test.ts's own suite
    // already pins down that a local write invalidates that key; this pins
    // down that the row itself reacts correctly once it does. Built with an
    // explicit `QueryClient`, bypassing this file's own `render` wrapper,
    // because the test needs to invalidate that exact client's cache by
    // hand rather than trusting a real write's own plumbing (out of scope
    // for a component-level test).
    it("stops showing a referrer once its Reference is removed and the cache is invalidated", async () => {
      const dayReferrers = vi.fn(async () => [referrer()]);
      const queryClient = new QueryClient();
      rtlRender(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <History
              entries={[entry({ id: "1", createdAt: "2026-08-28T10:00:00.000Z" })]}
              syncEnabled={false}
              dayReferrers={dayReferrers}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await screen.findByText("Referred to by 1 Entry:");

      dayReferrers.mockResolvedValue([]);
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: dayReferrersQueryKey("2026-08-28") });
      });

      await waitFor(() => expect(screen.queryByText(/Referred to by/)).not.toBeInTheDocument());
    });
  });
});
