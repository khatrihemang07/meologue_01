import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { HistoryPage } from "./history-page";

// The store never gets a chance to actually open here — the gear link is
// present regardless of store status (loading, ready, or error), so the
// driver is mocked to a promise that never settles, keeping this test clear
// of the real OPFS/Worker machinery entirely (that's exercised by the e2e
// suite, not a unit test).
vi.mock("@/platform/sqlite-driver", () => ({
  createDriver: () => new Promise(() => {}),
}));

describe("HistoryPage", () => {
  it("renders a gear link to Settings", () => {
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });
});
