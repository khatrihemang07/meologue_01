import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { ComposerPage } from "./composer-page";

// See history-page.test.tsx — same stand-in for surfacing the current
// "?q=..." from MemoryRouter's own in-memory history.
function SearchParamProbe() {
  const [searchParams] = useSearchParams();
  return <p data-testid="url-query">{searchParams.toString()}</p>;
}

// EntryStoreLayout is what normally supplies this context (it owns the
// store and useHistory); stubbing it with a bare Outlet lets these tests
// exercise ComposerPage in isolation with a context of their choosing,
// without touching the real store-opening machinery. Wrapped in a
// QueryClientProvider because Search (ticket 39, extended to this page by
// ticket 55) reads through a TanStack Query query of its own, same
// requirement history-page.test.tsx already has.
function renderComposerPage(context: EntryStoreOutletContext, initialPath = "/") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SearchParamProbe />
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path="/" element={<ComposerPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const readyContext: EntryStoreOutletContext = {
  entries: [],
  sendEntry: vi.fn(),
  search: vi.fn(async () => []),
  disabled: false,
};

describe("ComposerPage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders persistent nav links to Composer, History and Reflect, plus a Settings action", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // Ticket 54's acceptance criteria: the current destination is visibly
  // indicated. Composer is "/", the page under test, so its nav link
  // carries aria-current="page" and History's and Reflect's don't (ADR
  // 0020 added Reflect as the third destination).
  it("marks Composer as the current destination in the persistent nav", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "History" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Reflect" })).not.toHaveAttribute("aria-current");
  });

  it("disables the Composer while the store isn't ready", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      search: vi.fn(async () => []),
      disabled: true,
    });

    expect(screen.getByPlaceholderText("What's on your mind?")).toBeDisabled();
  });

  it("shows the store's error message", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      search: vi.fn(async () => []),
      disabled: true,
      message: "meologue couldn't open its storage. Reloading may help.",
    });

    expect(
      screen.getByText("meologue couldn't open its storage. Reloading may help."),
    ).toBeInTheDocument();
  });

  it("renders History from the outlet context", () => {
    renderComposerPage({
      entries: [
        { id: "1", deviceId: "device-a", body: "hello", createdAt: "now", seq: 1, syncedAt: "now" },
      ],
      sendEntry: vi.fn(),
      search: vi.fn(async () => []),
      disabled: false,
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  // Ticket 53: the thread next to the Composer reads oldest-to-newest, the
  // reverse of what the outlet context hands it (store order — see
  // history.tsx's groupByDay comment). Three same-day Entries so this only
  // exercises the reversal, not day-separator placement.
  it("reverses the store's newest-first order to oldest-to-newest reading order", () => {
    renderComposerPage({
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
      search: vi.fn(async () => []),
      disabled: false,
    });

    const bodies = screen.getAllByText(/^(first|second|third)$/).map((el) => el.textContent);
    expect(bodies).toEqual(["first", "second", "third"]);
  });

  it("shows a hint that Sync is off when no Server URL is set", () => {
    renderComposerPage(readyContext);

    expect(screen.getByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a server url/i })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("hides the hint once a Server URL is set", () => {
    useSettingsStore.getState().setServerUrl("https://phone.example:41207");

    renderComposerPage(readyContext);

    expect(screen.queryByText(/sync is off/i)).not.toBeInTheDocument();
  });

  // Ticket 55: Search moves into the app bar as a mode rather than a
  // destination, and this page is one of the two it now works on (the
  // other is history-page.test.tsx, which has the identical set of
  // assertions plus the sessionStorage-backup cases already covered there
  // — this file only needs to prove the wiring works here too, not
  // re-prove every edge use-history-search.ts already owns).
  describe("Search", () => {
    it("shows no search field until the magnifier is tapped", () => {
      renderComposerPage(readyContext);

      expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Search History" })).toBeInTheDocument();
    });

    it("tapping the magnifier expands the app bar into a search field", () => {
      renderComposerPage(readyContext);

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));

      expect(screen.getByRole("searchbox", { name: "Search History" })).toBeInTheDocument();
      // The title/Sync-dot row is what the field replaces "in place" — it's
      // gone while searching, not merely covered.
      expect(screen.queryByText("meologue")).not.toBeInTheDocument();
    });

    it("narrows the Composer's thread to what the store's search returns", async () => {
      // A match not already in the unfiltered fallback list, so finding it
      // proves the real (async) search result landed, not the fallback
      // useEntrySearch shows while that search is still in flight — same
      // technique history-page.test.tsx uses for the identical race.
      const searchOnlyMatch = {
        id: "3",
        deviceId: "device-a",
        body: "a match only search returns",
        createdAt: "now",
        seq: 3,
        syncedAt: "now",
      };
      const search = vi.fn(async (query: string) => (query === "wor" ? [searchOnlyMatch] : []));

      renderComposerPage({
        entries: [
          {
            id: "1",
            deviceId: "device-a",
            body: "hello",
            createdAt: "now",
            seq: 1,
            syncedAt: "now",
          },
          {
            id: "2",
            deviceId: "device-a",
            body: "world",
            createdAt: "now",
            seq: 2,
            syncedAt: "now",
          },
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

    // Ticket 53's hard constraint, extended to this page by ticket 55:
    // `search()` is contractually the same order as `list()` (ADR 0014,
    // newest-first) — narrowing to a search result must reverse to
    // oldest-to-newest exactly like the unfiltered thread does, on the
    // Composer-adjacent thread as much as on history-page.test.tsx's own
    // identical assertion.
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

      const { container } = renderComposerPage({
        entries: [],
        sendEntry: vi.fn(),
        search,
        disabled: false,
      });

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "search" },
      });

      // The matched "search" prefix is highlighted (highlight-match.ts) into
      // its own <mark>, so each Entry's body is split across sibling text
      // nodes — waiting for "older" with exact:false, same as
      // history-page.test.tsx's identical assertion, is what tolerates that.
      await screen.findByText("older", { exact: false });
      const bodies = Array.from(container.querySelectorAll("p.whitespace-pre-wrap")).map(
        (el) => el.textContent,
      );
      expect(bodies).toEqual(["search-older", "search-newer"]);
    });

    it("puts what the user types into the URL without pushing an entry per keystroke", () => {
      renderComposerPage(readyContext);

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "wor" },
      });

      expect(screen.getByTestId("url-query")).toHaveTextContent("q=wor");
    });

    // Ticket 55's dismiss half of the acceptance criteria, exercised on
    // this page too — history-page.test.tsx (via Shell) covers this same
    // rule; this proves ComposerPage wires Shell's onDismiss the same way.
    it("dismissing search restores the app bar and clears the narrowing", () => {
      renderComposerPage({
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
        search: vi.fn(async () => []),
        disabled: false,
      });

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "wor" },
      });
      expect(screen.getByTestId("url-query")).toHaveTextContent("q=wor");

      fireEvent.click(screen.getByRole("button", { name: "Close search" }));

      expect(screen.queryByRole("searchbox", { name: "Search History" })).not.toBeInTheDocument();
      expect(screen.getByTestId("url-query")).toHaveTextContent("");
      expect(screen.getByText("hello")).toBeInTheDocument();
    });

    it("seeds the search field open from a query already in the URL", async () => {
      const search = vi.fn(async () => [
        { id: "2", deviceId: "device-a", body: "world", createdAt: "now", seq: 1, syncedAt: "now" },
      ]);

      renderComposerPage(
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
        "/?q=wor",
      );

      expect(screen.getByRole("searchbox", { name: "Search History" })).toHaveValue("wor");
      expect(await screen.findByText("world")).toBeInTheDocument();
    });
  });
});
