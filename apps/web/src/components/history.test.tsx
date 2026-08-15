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
});
