import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { ComposerPage } from "./composer-page";

// Stand-in for surfacing the current "?q=..." from MemoryRouter's own
// in-memory history.
function SearchParamProbe() {
  const [searchParams] = useSearchParams();
  return <p data-testid="url-query">{searchParams.toString()}</p>;
}

// EntryStoreLayout is what normally supplies this context (it owns the
// store and useHistory); stubbing it with a bare Outlet lets these tests
// exercise ComposerPage in isolation with a context of their choosing,
// without touching the real store-opening machinery. Wrapped in a
// QueryClientProvider because Search (ticket 39, extended to this page by
// ticket 55) reads through a TanStack Query query of its own.
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
  editEntry: vi.fn(),
  removeEntry: vi.fn(),
  search: vi.fn(async () => []),
  pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
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

  // Issue #75: History is gone and Settings is now the fourth Nav
  // destination rather than a separate app-bar action — see nav.test.tsx
  // for the dedicated "exactly four" assertion.
  it("renders persistent nav links to Composer, Reflect, Digest and Settings", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Reflect" })).toHaveAttribute("href", "/reflect");
    expect(screen.getByRole("link", { name: "Digest" })).toHaveAttribute("href", "/digest");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // Ticket 54's acceptance criteria: the current destination is visibly
  // indicated. Composer is "/", the page under test, so its nav link
  // carries aria-current="page" and the other three don't.
  it("marks Composer as the current destination in the persistent nav", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Composer" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Reflect" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Digest" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });

  it("disables the Composer while the store isn't ready", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      removeEntry: vi.fn(),
      search: vi.fn(async () => []),
      pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
      disabled: true,
    });

    expect(screen.getByPlaceholderText("What's on your mind?")).toBeDisabled();
  });

  it("shows the store's error message", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      removeEntry: vi.fn(),
      search: vi.fn(async () => []),
      pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
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
        {
          id: "1",
          deviceId: "device-a",
          body: "hello",
          createdAt: "now",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
      ],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      removeEntry: vi.fn(),
      search: vi.fn(async () => []),
      pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
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
          deletedAt: null,
        },
        {
          id: "2",
          deviceId: "device-a",
          body: "second",
          createdAt: "2026-08-18T11:00:00.000Z",
          seq: 2,
          syncedAt: "now",
          deletedAt: null,
        },
        {
          id: "1",
          deviceId: "device-a",
          body: "first",
          createdAt: "2026-08-18T10:00:00.000Z",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
      ],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      removeEntry: vi.fn(),
      search: vi.fn(async () => []),
      pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
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
  // destination. Issue #75 deleted History's own page, so the Composer is
  // now the only page in EntryStoreLayout Search narrows this way (Sessions'
  // own search, sessions-page.tsx, is a separate collection with its own
  // tests) — this file proves the wiring works here, not every edge
  // use-history-search.ts already owns.
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
      // useEntrySearch shows while that search is still in flight.
      const searchOnlyMatch = {
        id: "3",
        deviceId: "device-a",
        body: "a match only search returns",
        createdAt: "now",
        seq: 3,
        syncedAt: "now",
        deletedAt: null,
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
            deletedAt: null,
          },
          {
            id: "2",
            deviceId: "device-a",
            body: "world",
            createdAt: "now",
            seq: 2,
            syncedAt: "now",
            deletedAt: null,
          },
        ],
        sendEntry: vi.fn(),
        editEntry: vi.fn(),
        removeEntry: vi.fn(),
        search,
        pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
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
    // oldest-to-newest exactly like the unfiltered thread does.
    it("reverses a search result's order the same way it reverses the unfiltered thread", async () => {
      const search = vi.fn(async () => [
        {
          id: "2",
          deviceId: "device-a",
          body: "search-newer",
          createdAt: "2026-08-18T12:00:00.000Z",
          seq: 2,
          syncedAt: "now",
          deletedAt: null,
        },
        {
          id: "1",
          deviceId: "device-a",
          body: "search-older",
          createdAt: "2026-08-18T10:00:00.000Z",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
      ]);

      const { container } = renderComposerPage({
        entries: [],
        sendEntry: vi.fn(),
        editEntry: vi.fn(),
        removeEntry: vi.fn(),
        search,
        pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
        disabled: false,
      });

      fireEvent.click(screen.getByRole("button", { name: "Search History" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Search History" }), {
        target: { value: "search" },
      });

      // The matched "search" prefix is highlighted (highlight-match.ts) into
      // its own <mark>, so each Entry's body is split across sibling text
      // nodes — waiting for "older" with exact:false is what tolerates
      // that.
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

    // Ticket 55's dismiss half of the acceptance criteria — shell.test.tsx
    // covers the rule itself; this proves ComposerPage wires Shell's
    // onDismiss the same way.
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
            deletedAt: null,
          },
        ],
        sendEntry: vi.fn(),
        editEntry: vi.fn(),
        removeEntry: vi.fn(),
        search: vi.fn(async () => []),
        pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
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
        {
          id: "2",
          deviceId: "device-a",
          body: "world",
          createdAt: "now",
          seq: 1,
          syncedAt: "now",
          deletedAt: null,
        },
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
              deletedAt: null,
            },
          ],
          sendEntry: vi.fn(),
          editEntry: vi.fn(),
          removeEntry: vi.fn(),
          search,
          pagination: { hasMore: false, fetching: false, fetchMore: vi.fn() },
          disabled: false,
        },
        "/?q=wor",
      );

      expect(screen.getByRole("searchbox", { name: "Search History" })).toHaveValue("wor");
      expect(await screen.findByText("world")).toBeInTheDocument();
    });
  });

  // ADR 0028 (issue #78): this is the real wiring — EntryRow's actions,
  // through History's shared EntryActionsSheet, into ComposerPage's own
  // editingEntry state and the docked Composer. Each layer already has its
  // own focused test (entry-row.test.tsx, entry-actions.test.tsx,
  // composer.test.tsx, use-history.test.tsx); this is the one place that
  // proves they're actually connected. jsdom has no `matchMedia`
  // (entry-actions.tsx's `hoverCapable()` reads that as "no hover"), so a
  // plain tap on the row here opens the sheet exactly as it would on a
  // touch device — no explicit stub needed for that default.
  describe("Edit and Delete from a row's shared actions sheet", () => {
    const oneEntry: EntryStoreOutletContext["entries"] = [
      {
        id: "1",
        deviceId: "device-a",
        body: "hello",
        createdAt: "now",
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      },
    ];

    it("choosing Edit puts the Composer into editing mode, seeded with the Entry's body", async () => {
      renderComposerPage({ ...readyContext, entries: oneEntry });

      fireEvent.click(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Edit"));

      expect(screen.getByText("Editing Entry")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("What's on your mind?")).toHaveValue("hello");
    });

    // Issue #82: choosing Delete opens a confirm dialog rather than
    // calling removeEntry on the spot (the ConfirmDialog history.tsx
    // renders, one level above every row); removeEntry only fires once
    // that confirmation is accepted.
    it("choosing Delete, then confirming, calls removeEntry from the outlet context with the whole Entry", async () => {
      const removeEntry = vi.fn();
      renderComposerPage({ ...readyContext, entries: oneEntry, removeEntry });

      fireEvent.click(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Delete"));

      expect(removeEntry).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(removeEntry).toHaveBeenCalledWith(oneEntry[0]);
    });
  });
});
