import type { Entry } from "@meologue/core";
import { render, screen } from "@testing-library/react";
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
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
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
});
