import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
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
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("marks an unsynced Entry when a Server URL is set", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");

    renderHistoryPage({
      entries: [
        {
          id: "1",
          deviceId: "device-a",
          body: "hello",
          createdAt: "now",
          seq: null,
          syncedAt: null,
        },
      ],
      sendEntry: vi.fn(),
      disabled: false,
    });

    expect(screen.getByLabelText("Not yet synced")).toBeInTheDocument();
  });

  it("never shows the Sync-is-off hint, even with no Server URL set", () => {
    renderHistoryPage({ entries: [], sendEntry: vi.fn(), disabled: false });

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
  });
});
