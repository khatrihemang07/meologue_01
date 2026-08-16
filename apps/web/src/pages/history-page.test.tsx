import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { HistoryPage } from "./history-page";

// MemoryRouter keeps its own in-memory history, not window.location — this
// surfaces the current "?q=..." from inside that history so a test can
// assert Search actually lands in the URL (ticket 39), not just in memory.
function SearchParamProbe() {
  const [searchParams] = useSearchParams();
  return <p data-testid="url-query">{searchParams.toString()}</p>;
}

// See composer-page.test.tsx — same stand-in for EntryStoreLayout. Wrapped
// in a QueryClientProvider because Search (ticket 39) reads through a
// TanStack Query query of its own, on top of the outlet context.
function renderHistoryPage(context: EntryStoreOutletContext, initialPath = "/history") {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SearchParamProbe />
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path="/history" element={<HistoryPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const noSearchResults = vi.fn(async () => []);

describe("HistoryPage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a way back to the Composer", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/");
  });

  it("renders History from the outlet context", () => {
    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("shows the store's error message", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search: noSearchResults,
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
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getByLabelText("Not yet synced")).toBeInTheDocument();
  });

  it("never shows the Sync-is-off hint, even with no Server URL set", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
  });

  it("shows the full, unfiltered History when the search box is empty", () => {
    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
        { id: "2", deviceId: "device-a", body: "world", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
  });

  it("narrows to what the store's search returns as the user types", async () => {
    // A match not already in the unfiltered fallback list, so finding it
    // proves the real (async) search result landed, not the fallback
    // useEntrySearch shows while that search is still in flight.
    const searchOnlyMatch = {
      id: "3",
      deviceId: "device-a",
      body: "a match only search returns",
      createdAt: "now",
      seq: 1,
      syncedAt: "now",
    };
    const search = vi.fn(async (query: string) => (query === "wor" ? [searchOnlyMatch] : []));

    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
        { id: "2", deviceId: "device-a", body: "world", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search,
      disabled: false,
    });

    fireEvent.change(screen.getByLabelText("Search History"), { target: { value: "wor" } });

    expect(await screen.findByText("a match only search returns")).toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    expect(screen.queryByText("world")).not.toBeInTheDocument();
    expect(search).toHaveBeenLastCalledWith("wor");
  });

  it("clearing the search box restores the full History", async () => {
    const search = vi.fn(async () => []);

    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
        { id: "2", deviceId: "device-a", body: "world", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search,
      disabled: false,
    });

    const box = screen.getByLabelText("Search History");
    fireEvent.change(box, { target: { value: "wor" } });
    await screen.findByText("No matching Entries.");

    fireEvent.change(box, { target: { value: "" } });

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
  });

  it("seeds the search box from a query already in the URL, and searches with it", async () => {
    const search = vi.fn(async () => [
      { id: "2", deviceId: "device-a", body: "world", createdAt: "now", seq: 1, syncedAt: "now" },
    ]);

    renderHistoryPage(
      {
        entries: [
          {
            id: "1",
            deviceId: "device-a",
            body: "hello",
            createdAt: "now",
            seq: 1,
            syncedAt: "now",
          },
        ],
        sendEntry: vi.fn(),
        search,
        disabled: false,
      },
      "/history?q=wor",
    );

    expect(screen.getByLabelText("Search History")).toHaveValue("wor");
    expect(await screen.findByText("world")).toBeInTheDocument();
  });

  it("restores a search a round trip through Settings dropped from the URL", async () => {
    const search = vi.fn(async () => [
      { id: "2", deviceId: "device-a", body: "world", createdAt: "now", seq: 1, syncedAt: "now" },
    ]);

    // Simulates the search having been active on an earlier visit this tab
    // (BackLink/HistoryLink round-tripping through Composer and Settings
    // both land on bare paths with no query, per nav-links.tsx).
    sessionStorage.setItem("meologue.history-search-query", "wor");

    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search,
      disabled: false,
    });

    expect(await screen.findByText("world")).toBeInTheDocument();
    expect(screen.getByLabelText("Search History")).toHaveValue("wor");
    expect(screen.getByTestId("url-query")).toHaveTextContent("q=wor");
  });

  it("does not resurrect a search the user explicitly cleared on an earlier visit", () => {
    sessionStorage.setItem("meologue.history-search-query", "wor");

    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    fireEvent.change(screen.getByLabelText("Search History"), { target: { value: "" } });
    expect(sessionStorage.getItem("meologue.history-search-query")).toBeNull();

    // A later visit (e.g. after another round trip through Settings) must
    // not bring the cleared search back.
    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getAllByLabelText("Search History").at(-1)).toHaveValue("");
  });

  it("a query already in the URL wins over a stored one, rather than being second-guessed", () => {
    sessionStorage.setItem("meologue.history-search-query", "stale");

    renderHistoryPage(
      { entries: [], sendEntry: vi.fn(), search: noSearchResults, disabled: false },
      "/history?q=fresh",
    );

    expect(screen.getByLabelText("Search History")).toHaveValue("fresh");
  });

  it("puts what the user types into the URL", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    fireEvent.change(screen.getByLabelText("Search History"), { target: { value: "wor" } });

    expect(screen.getByTestId("url-query")).toHaveTextContent("q=wor");
  });
});
