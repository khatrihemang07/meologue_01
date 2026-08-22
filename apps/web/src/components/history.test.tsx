import type { Entry } from "@meologue/core";
import { fireEvent, render, screen } from "@testing-library/react";
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
});

describe("History", () => {
  it("shows an Entry's capture time as a clock time, not a date", () => {
    render(
      <History entries={[entry({ createdAt: "2026-08-15T17:27:00.000Z" })]} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
    expect(time.tagName).toBe("TIME");
    expect(time).not.toHaveTextContent(/2026/);
  });

  it("puts a more precise absolute timestamp on hover", () => {
    render(
      <History entries={[entry({ createdAt: "2026-08-15T17:27:00.000Z" })]} syncEnabled={false} />,
    );

    const time = screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
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

  // ADR 0028: History assembles EntryRow's `actions` from its own onEdit
  // and onDelete props — both or neither, never one alone (see the props'
  // own comment). Both-present is exercised end to end by
  // composer-page.test.tsx; this pins down the gating itself, including
  // the intentionally-unhandled "only one given" case, at this component's
  // own level.
  describe("the Edit/Delete context menu", () => {
    it("wires no menu when neither onEdit nor onDelete is given", () => {
      render(<History entries={[entry({ body: "hello" })]} syncEnabled={false} />);

      fireEvent.contextMenu(screen.getByText("hello"));

      expect(screen.queryByText("Edit")).not.toBeInTheDocument();
      expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    });

    it("wires no menu when only one of onEdit/onDelete is given", () => {
      render(<History entries={[entry({ body: "hello" })]} syncEnabled={false} onEdit={vi.fn()} />);

      fireEvent.contextMenu(screen.getByText("hello"));

      expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    });

    it("wires a working menu onto every row when both are given", async () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const target = entry({ body: "hello" });
      render(
        <History entries={[target]} syncEnabled={false} onEdit={onEdit} onDelete={onDelete} />,
      );

      fireEvent.contextMenu(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Edit"));

      expect(onEdit).toHaveBeenCalledWith(target);
    });
  });
});
