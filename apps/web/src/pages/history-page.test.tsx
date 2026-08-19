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
  return render(
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

  it("renders persistent nav links to Composer, History and Reflect, plus a Settings action", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // Ticket 54's acceptance criteria: the current destination is visibly
  // indicated. History is "/history", the page under test, so Composer's
  // and Reflect's links (ADR 0020's third destination) don't carry it.
  it("marks History as the current destination in the persistent nav", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Composer" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Reflect" })).not.toHaveAttribute("aria-current");
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

  // Ticket 53: /history reads oldest-to-newest same as the Composer-adjacent
  // thread (composer-page.test.tsx has the identical assertion for `/`) —
  // the outlet context hands both pages the store's newest-first order
  // (`list()`'s `ORDER BY created_at DESC`), and reversing it is this
  // page's own job, not a shared one, since each page reverses its own
  // `shown` view independently.
  it("reverses the store's newest-first order to oldest-to-newest reading order", () => {
    renderHistoryPage({
      entries: [
        {
          id: "3",
          deviceId: "device-a",
          body: "third",
          createdAt: "2026-08-18T12:00:00.000Z",
          seq: 3,
          syncedAt: "now",
        },
        {
          id: "2",
          deviceId: "device-a",
          body: "second",
          createdAt: "2026-08-18T11:00:00.000Z",
          seq: 2,
          syncedAt: "now",
        },
        {
          id: "1",
          deviceId: "device-a",
          body: "first",
          createdAt: "2026-08-18T10:00:00.000Z",
          seq: 1,
          syncedAt: "now",
        },
      ],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    const bodies = screen.getAllByText(/^(first|second|third)$/).map((el) => el.textContent);
    expect(bodies).toEqual(["first", "second", "third"]);
  });

  // Ticket 53's hard constraint: `search()` is contractually the same
  // order as `list()` (ADR 0014, newest-first) — a search result reverses
  // to oldest-to-newest exactly like the unfiltered thread does, so
  // narrowing to a search never flips the reading order the reader was
  // already used to.
  it("reverses a search result's order the same way it reverses the unfiltered thread", async () => {
    const search = vi.fn(async () => [
      {
        id: "2",
        deviceId: "device-a",
        body: "search-newer",
        createdAt: "2026-08-18T12:00:00.000Z",
        seq: 2,
        syncedAt: "now",
      },
      {
        id: "1",
        deviceId: "device-a",
        body: "search-older",
        createdAt: "2026-08-18T10:00:00.000Z",
        seq: 1,
        syncedAt: "now",
      },
    ]);

    const { container } = renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search,
      disabled: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Search History" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
      target: { value: "search" },
    });

    await screen.findByText("older", { exact: false });
    // The matched "search" prefix is highlighted (highlight-match.ts) into
    // its own <mark>, so each Entry's body is split across sibling nodes —
    // querying the row (`<p>`) rather than `getByText` is what reads it back
    // as one string, `mark` and plain text concatenated in DOM order.
    const bodies = Array.from(container.querySelectorAll("p.whitespace-pre-wrap")).map(
      (el) => el.textContent,
    );
    expect(bodies).toEqual(["search-older", "search-newer"]);
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

    fireEvent.click(screen.getByRole("button", { name: "Search History" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
      target: { value: "wor" },
    });

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

    fireEvent.click(screen.getByRole("button", { name: "Search History" }));
    const box = screen.getByRole("searchbox", { name: "Search History" });
    fireEvent.change(box, { target: { value: "wor" } });
    await screen.findByText("No matching Entries.");

    fireEvent.change(box, { target: { value: "" } });

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
    // Clearing the text (rather than dismissing via the close button) keeps
    // the field open — ticket 55's rule that leaving search mode is only
    // ever an explicit act, not a side effect of the query becoming empty.
    expect(screen.getByRole("searchbox", { name: "Search History" })).toBeInTheDocument();
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

    expect(screen.getByRole("searchbox", { name: "Search History" })).toHaveValue("wor");
    expect(await screen.findByText("world")).toBeInTheDocument();
  });

  it("restores a search a round trip through Settings dropped from the URL", async () => {
    const search = vi.fn(async () => [
      { id: "2", deviceId: "device-a", body: "world", createdAt: "now", seq: 1, syncedAt: "now" },
    ]);

    // Simulates the search having been active on an earlier visit this tab
    // (the persistent Nav and Settings action, both bare `to="/..."` links
    // with no query string — see nav.tsx — drop it on a round trip through
    // Settings, ticket 54's search.spec.ts e2e test exercises the same
    // round trip end to end).
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
    // The field opens on its own here — nothing was clicked — because a
    // non-empty query (restored from sessionStorage, in this case) is
    // reason enough to be in search mode (ticket 55: Shell's `searchOpen`
    // is seeded from `search.query`, not only from the magnifier click).
    expect(screen.getByRole("searchbox", { name: "Search History" })).toHaveValue("wor");
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

    fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
      target: { value: "" },
    });
    expect(sessionStorage.getItem("meologue.history-search-query")).toBeNull();

    // A later visit (e.g. after another round trip through Settings) must
    // not bring the cleared search back — no new search field opens,
    // because nothing is left in sessionStorage or the URL to restore. The
    // first instance's field is still open (clearing text doesn't dismiss
    // it — see the "clearing the search box" test above), so exactly one
    // searchbox exists across both instances, not two.
    renderHistoryPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    expect(screen.getAllByRole("searchbox", { name: "Search History" })).toHaveLength(1);
  });

  it("a query already in the URL wins over a stored one, rather than being second-guessed", () => {
    sessionStorage.setItem("meologue.history-search-query", "stale");

    renderHistoryPage(
      { entries: [], sendEntry: vi.fn(), search: noSearchResults, disabled: false },
      "/history?q=fresh",
    );

    expect(screen.getByRole("searchbox", { name: "Search History" })).toHaveValue("fresh");
  });

  it("puts what the user types into the URL", () => {
    renderHistoryPage({
      entries: [],
      sendEntry: vi.fn(),
      search: noSearchResults,
      disabled: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Search History" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
      target: { value: "wor" },
    });

    expect(screen.getByTestId("url-query")).toHaveTextContent("q=wor");
  });
});
