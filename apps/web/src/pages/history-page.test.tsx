import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { HistoryPage } from "./history-page";

// See composer-page.test.tsx — same stand-in for EntryStoreLayout.
function renderHistoryPage(context: EntryStoreOutletContext) {
  render(
    <MemoryRouter initialEntries={["/history"]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="/history" element={<HistoryPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("HistoryPage", () => {
  it("renders a way back to the Composer", () => {
    renderHistoryPage({ entries: [], sendEntry: vi.fn(), disabled: false });

    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/");
  });

  it("renders History from the outlet context", () => {
    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      disabled: false,
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("shows the store's error message", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      disabled: true,
      message: "meologue couldn't open its storage. Reloading may help.",
    });

    expect(
      screen.getByText("meologue couldn't open its storage. Reloading may help."),
    ).toBeInTheDocument();
  });
});
