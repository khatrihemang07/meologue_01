import type { Entry } from "@meologue/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { History } from "./history";

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

describe("History", () => {
  it("shows an Entry's capture time as a date and clock time", () => {
    render(
      <History entries={[entry({ createdAt: "2026-08-15T17:27:00.000Z" })]} syncEnabled={false} />,
    );

    expect(screen.getByText(/2026.*\d{1,2}:\d{2}\s?(AM|PM)$/i)).toBeInTheDocument();
  });

  it("puts a more precise absolute timestamp on hover", () => {
    render(
      <History entries={[entry({ createdAt: "2026-08-15T17:27:00.000Z" })]} syncEnabled={false} />,
    );

    const time = screen.getByText(/2026.*\d{1,2}:\d{2}\s?(AM|PM)$/i);
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("title", expect.stringMatching(/2026.*:\d{2}:\d{2}\s?(AM|PM)$/i));
  });

  it("renders nothing for an Entry whose createdAt doesn't parse as a date", () => {
    const { container } = render(
      <History entries={[entry({ createdAt: "now" })]} syncEnabled={false} />,
    );

    expect(container.querySelector("time")).not.toBeInTheDocument();
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
});
