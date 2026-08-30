import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/lib/settings";
import type { EntryStoreOutletContext } from "@/pages/entry-store-layout";
import { swipeLeft } from "@/test/swipe";
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
  getEntries: vi.fn(async () => []),
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

  // ADR 0036 retires the persistent nav: a destination is a pane pushed over
  // the root screen, so the way back out is a Back control rather than a nav
  // link that was always on screen. `nav.test.tsx`'s "exactly four
  // destinations" assertion moves with it, to `chat-list.test.tsx`.
  it("offers a Back control out to the root screen", () => {
    renderComposerPage(readyContext);

    expect(screen.getByRole("link", { name: "Back to chats" })).toHaveAttribute("href", "/");
  });

  it("disables the Composer while the store isn't ready", () => {
    renderComposerPage({
      entries: [],
      sendEntry: vi.fn(),
      editEntry: vi.fn(),
      removeEntry: vi.fn(),
      search: vi.fn(async () => []),
      getEntries: vi.fn(async () => []),
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
      getEntries: vi.fn(async () => []),
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
      getEntries: vi.fn(async () => []),
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
      getEntries: vi.fn(async () => []),
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
      expect(screen.queryByText("Composer")).not.toBeInTheDocument();
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
        getEntries: vi.fn(async () => []),
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
        getEntries: vi.fn(async () => []),
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
      const bodies = Array.from(container.querySelectorAll('[data-slot="bubble-body"]')).map(
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
        getEntries: vi.fn(async () => []),
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
          getEntries: vi.fn(async () => []),
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
  // #127: the sheet is reached by swiping a bubble left, not by tapping it.
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

      swipeLeft(screen.getByText("hello"));
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

      swipeLeft(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Delete"));

      expect(removeEntry).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(removeEntry).toHaveBeenCalledWith(oneEntry[0]);
    });
  });

  // Issue #144: the real, end-to-end wiring for "Refer" — History's shared
  // sheet, into this page's own `handleRefer`, into the docked Composer
  // via `composerRef`. Each layer already has its own focused test
  // (entry-row.test.tsx, entry-actions.test.tsx, history.test.tsx,
  // composer.test.tsx); this is the one place that proves they're actually
  // connected, the same role the Edit/Delete describe block just above
  // plays for those two actions.
  describe("Refer from a row's shared actions sheet", () => {
    const referredEntry: EntryStoreOutletContext["entries"][number] = {
      id: "referred-entry-id",
      deviceId: "device-a",
      body: "hello",
      createdAt: "now",
      seq: 1,
      syncedAt: "now",
      deletedAt: null,
    };

    it("puts a Reference to the Entry into the Composer, with no raw id visible in the sheet itself", async () => {
      renderComposerPage({ ...readyContext, entries: [referredEntry] });

      swipeLeft(screen.getByText("hello"));
      // The sheet names the action, never the id it acts on.
      expect(screen.queryByText(referredEntry.id)).not.toBeInTheDocument();
      fireEvent.click(await screen.findByText("Refer to this Entry"));

      expect(screen.getByPlaceholderText("What's on your mind?")).toHaveValue(
        `[[e:${referredEntry.id}]]`,
      );
    });

    // The Composer's `editingEntry` mode (ADR 0028) has its own textarea
    // state, seeded from the Entry being edited rather than from whatever
    // was mid-composition before — Refer has to land in THAT text, not
    // start a fresh, separate Entry the reader never asked for.
    it("inserts into an Entry already being edited, rather than starting a new Entry", async () => {
      const editEntry = vi.fn();
      const entries: EntryStoreOutletContext["entries"] = [
        { ...referredEntry, id: "being-edited", body: "editing this one" },
        { ...referredEntry, id: "referred-entry-id-2" },
      ];
      renderComposerPage({ ...readyContext, entries, editEntry });

      // Enter edit mode on the first Entry.
      swipeLeft(screen.getByText("editing this one"));
      fireEvent.click(await screen.findByText("Edit"));
      expect(screen.getByPlaceholderText("What's on your mind?")).toHaveValue("editing this one");

      // Refer to the second Entry while still editing the first.
      swipeLeft(screen.getByText("hello"));
      fireEvent.click(await screen.findByText("Refer to this Entry"));

      expect(screen.getByText("Editing Entry")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("What's on your mind?")).toHaveValue(
        "editing this one[[e:referred-entry-id-2]]",
      );
      expect(editEntry).not.toHaveBeenCalled();
    });
  });

  // Issue #142: following a date Reference lands here with `?d=YYYY-MM-DD`
  // (composer-page.tsx's own comment on why a query param, not a path
  // segment) — this page owns the seek: reading the param, deciding
  // whether to fetch another page or give up, and clearing the param once
  // there's nothing left to do.
  describe("a date-Reference seek (?d=)", () => {
    function seekEntry(id: string, createdAt: string): EntryStoreOutletContext["entries"][number] {
      return {
        id,
        deviceId: "device-a",
        body: `entry ${id}`,
        createdAt,
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      };
    }

    // A dedicated render helper for this describe block, rather than
    // `renderComposerPage` above: a couple of these tests need to
    // `rerender` with a *changed* outlet context (simulating an older page
    // landing) against the exact same QueryClient and MemoryRouter
    // instance — swapping in a brand-new QueryClient on rerender would
    // reset every query's cached state, not just the one this test cares
    // about.
    function renderSeek(context: EntryStoreOutletContext, initialPath: string) {
      const queryClient = new QueryClient();
      const utils = render(
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
      function rerenderWith(nextContext: EntryStoreOutletContext) {
        utils.rerender(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialPath]}>
              <SearchParamProbe />
              <Routes>
                <Route element={<Outlet context={nextContext} />}>
                  <Route path="/" element={<ComposerPage />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      }
      return { ...utils, rerenderWith };
    }

    it("clears ?d= once the target day is already loaded", async () => {
      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2020-01-01T10:00:00.000Z")],
        },
        "/?d=2020-01-01",
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("d="));
    });

    it("loads older pages until the target day appears, then clears ?d=", async () => {
      const fetchMore = vi.fn();
      const pagination = { hasMore: true, fetching: false, fetchMore };

      const { rerenderWith } = renderSeek(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination,
        },
        "/?d=2020-01-01",
      );

      await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("url-query")).toHaveTextContent("d=2020-01-01");

      // The page that request asked for lands, and it holds the target day.
      rerenderWith({
        ...readyContext,
        entries: [
          seekEntry("1", "2026-08-18T10:00:00.000Z"),
          seekEntry("2", "2020-01-01T10:00:00.000Z"),
        ],
        pagination,
      });

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("d="));
    });

    it("clears ?d= once there are no more older pages to check, without ever fetching", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: false, fetching: false, fetchMore },
        },
        "/?d=2020-01-01",
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("d="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("does not call fetchMore while a page is already in flight", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: true, fetching: true, fetchMore },
        },
        "/?d=2020-01-01",
      );

      // Give History's own effect a chance to run before asserting the
      // negative — otherwise this would pass trivially before anything had
      // a chance to fire at all.
      await waitFor(() => expect(screen.getByTestId("url-query")).toHaveTextContent("d="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("ignores a malformed ?d=, the same as no seek at all", () => {
      renderComposerPage(readyContext, "/?d=not-a-day");

      expect(screen.getByTestId("url-query")).toHaveTextContent("d=not-a-day");
    });
  });

  // Issue #143: following an Entry Reference's chip lands here with
  // `?e=<uuid>`, extending the exact same seek mechanism the `?d=` suite
  // above already covers — mirrored test for test.
  describe("an Entry-Reference seek (?e=)", () => {
    const targetId = "0192abcd-1234-7890-abcd-0123456789ab";

    function seekEntry(id: string, createdAt: string): EntryStoreOutletContext["entries"][number] {
      return {
        id,
        deviceId: "device-a",
        body: `entry ${id}`,
        createdAt,
        seq: 1,
        syncedAt: "now",
        deletedAt: null,
      };
    }

    // Same reasoning as the `?d=` suite's own `renderSeek`: a couple of
    // these tests need to `rerender` with a *changed* outlet context
    // (simulating an older page landing) against the exact same
    // QueryClient and MemoryRouter, so a fresh render per assertion isn't
    // an option.
    function renderSeek(context: EntryStoreOutletContext, initialPath: string) {
      const queryClient = new QueryClient();
      const utils = render(
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
      function rerenderWith(nextContext: EntryStoreOutletContext) {
        utils.rerender(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialPath]}>
              <SearchParamProbe />
              <Routes>
                <Route element={<Outlet context={nextContext} />}>
                  <Route path="/" element={<ComposerPage />} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      }
      return { ...utils, rerenderWith };
    }

    it("clears ?e= once the target Entry is already loaded", async () => {
      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry(targetId, "2020-01-01T10:00:00.000Z")],
        },
        `/?e=${targetId}`,
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("e="));
    });

    it("loads older pages until the target Entry appears, then clears ?e=", async () => {
      const fetchMore = vi.fn();
      const pagination = { hasMore: true, fetching: false, fetchMore };

      const { rerenderWith } = renderSeek(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination,
        },
        `/?e=${targetId}`,
      );

      await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("url-query")).toHaveTextContent(`e=${targetId}`);

      // The page that request asked for lands, and it holds the target Entry.
      rerenderWith({
        ...readyContext,
        entries: [
          seekEntry("1", "2026-08-18T10:00:00.000Z"),
          seekEntry(targetId, "2020-01-01T10:00:00.000Z"),
        ],
        pagination,
      });

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("e="));
    });

    it("clears ?e= once there are no more older pages to check, without ever fetching", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: false, fetching: false, fetchMore },
        },
        `/?e=${targetId}`,
      );

      await waitFor(() => expect(screen.getByTestId("url-query")).not.toHaveTextContent("e="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("does not call fetchMore while a page is already in flight", async () => {
      const fetchMore = vi.fn();

      renderComposerPage(
        {
          ...readyContext,
          entries: [seekEntry("1", "2026-08-18T10:00:00.000Z")],
          pagination: { hasMore: true, fetching: true, fetchMore },
        },
        `/?e=${targetId}`,
      );

      // Give History's own effect a chance to run before asserting the
      // negative — otherwise this would pass trivially before anything had
      // a chance to fire at all.
      await waitFor(() => expect(screen.getByTestId("url-query")).toHaveTextContent("e="));
      expect(fetchMore).not.toHaveBeenCalled();
    });

    it("ignores a malformed ?e=, the same as no seek at all", () => {
      renderComposerPage(readyContext, "/?e=not-a-uuid");

      expect(screen.getByTestId("url-query")).toHaveTextContent("e=not-a-uuid");
    });

    // The rule composer-page.tsx's own comment names: `?e=` wins
    // deterministically over `?d=` when both are present, rather than
    // either being silently dropped or the two racing each other.
    it("prefers ?e= over ?d= when both are present, ignoring ?d= entirely", async () => {
      const fetchMore = vi.fn();
      renderComposerPage(
        {
          ...readyContext,
          // This loaded Entry falls exactly on the day ?d= names — if
          // ?d= were the seek actually in flight, it would settle
          // immediately with no fetch, the same as "clears ?d= once the
          // target day is already loaded" above.
          entries: [seekEntry("1", "2020-01-01T10:00:00.000Z")],
          pagination: { hasMore: true, fetching: false, fetchMore },
        },
        `/?d=2020-01-01&e=${targetId}`,
      );

      // The target Entry (targetId) is not loaded, so a seek genuinely
      // keyed on ?e= has to ask for an older page instead of settling —
      // proof ?e=, not the trivially-satisfiable ?d=, is the seek in
      // flight.
      await waitFor(() => expect(fetchMore).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("url-query")).toHaveTextContent(`e=${targetId}`);
      expect(screen.getByTestId("url-query")).toHaveTextContent("d=2020-01-01");
    });
  });
});
