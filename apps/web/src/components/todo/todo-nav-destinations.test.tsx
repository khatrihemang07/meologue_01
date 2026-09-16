import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { BrowseView } from "./browse-view";
import { TodoNav } from "./todo-nav";
import { TODO_NAV_DESTINATIONS } from "./todo-nav-destinations";
import { TodoSidebar } from "./todo-sidebar";

const { openEntryStoreMock } = vi.hoisted(() => ({
  openEntryStoreMock: vi.fn(),
}));

// The identical stand-in todo-sidebar.test.tsx and chat-shell-layout.test.tsx
// already use, for the identical structural reason: TodoSidebar reads the
// Entry store outside EntryStoreLayout's own Outlet (todo-sidebar.tsx's own
// header comment), so mounting it needs this mock rather than a real
// SqliteDriver.
vi.mock("@/pages/entry-store-layout", () => ({
  entryStoreQueryOptions: queryOptions({
    queryKey: ENTRY_STORE_QUERY_KEY,
    queryFn: openEntryStoreMock,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    retryOnMount: false,
  }),
}));

function renderNavHrefs() {
  const { unmount } = render(
    <MemoryRouter initialEntries={["/todo/inbox"]}>
      <TodoNav />
    </MemoryRouter>,
  );
  const hrefs = new Set(screen.getAllByRole("link").map((link) => link.getAttribute("href")));
  unmount();
  return hrefs;
}

async function renderSidebarHrefs() {
  openEntryStoreMock.mockReset();
  openEntryStoreMock.mockResolvedValue({
    taskStore: { list: () => Promise.resolve([]) },
    projectStore: { listProjects: () => Promise.resolve([]) },
    filterStore: { list: () => Promise.resolve([]) },
  });
  const queryClient = new QueryClient();
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/todo/inbox"]}>
        <TodoSidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const nav = await screen.findByRole("navigation", { name: "Todo" });
  const hrefs = new Set(
    within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href")),
  );
  unmount();
  return hrefs;
}

// ANAV-01: Browse (`browse-view.tsx`) is the bar's own fourth row's
// destination, and the third leg the reachability test below now checks
// alongside the bar and the sidebar — everything `TODO_BAR_DESTINATIONS`
// (todo-nav-destinations.ts) no longer carries a row for has to still show
// up here, or it is unreachable below the 1200px sidebar breakpoint.
function renderBrowseHrefs() {
  const { unmount } = render(
    <MemoryRouter initialEntries={["/todo/browse"]}>
      <BrowseView />
    </MemoryRouter>,
  );
  const nav = screen.getByRole("navigation", { name: "Browse" });
  const hrefs = new Set(
    within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href")),
  );
  unmount();
  return hrefs;
}

/**
 * Defect 33's own class, and the deliverable the ticket that fixed it
 * asked for: not just `/todo/projects` reachable again, but a test that
 * keeps `todo-nav.tsx` (below 900px) and `todo-sidebar.tsx` (900px and
 * up) from ever silently disagreeing about which single-view destinations
 * exist, the way they already had twice — `/todo/upcoming` missing from
 * `todo-nav.tsx` for a full release (issue #223), then `/todo/projects`
 * missing from `todo-sidebar.tsx` for longer still, until this ticket.
 * `todo-nav.tsx` hides itself the instant `todo-sidebar.tsx` takes over
 * (ADR 0076) — there is no third path to a destination missing from
 * whichever one is on screen, so "reachable from one navigation" and
 * "reachable" stop meaning the same thing the moment they disagree.
 *
 * **ANAV-01 made "both navigations link every destination identically"
 * false by construction** — that used to be this describe block's own
 * first test, verbatim. `TodoNav`'s bar now deliberately carries only
 * four of `TODO_NAV_DESTINATIONS`'s six (`todo-nav-destinations.ts`'s own
 * header comment has the full reasoning), with Browse
 * (`browse-view.tsx`) as the fourth row's own destination — a hub, not a
 * `TODO_NAV_DESTINATIONS` entry itself, that re-links Filters, Activity
 * and Projects one tap further in. Asserting the old invariant verbatim
 * would now fail on a correct build, for no defect at all: exactly the
 * "a convenient fixture is the one most likely to be degenerate" trap a
 * stale assertion sets for whoever reads it next.
 *
 * **The invariant this file actually has to hold is reachability, not
 * list equality**: every destination in `TODO_NAV_DESTINATIONS` still has
 * to be one tap away from *something* always on screen below the sidebar
 * breakpoint — the bar itself, or Browse, which the bar's own fourth row
 * always reaches. `TodoSidebar` keeps its own, stricter invariant
 * unchanged (every destination, directly, the way it always has) since
 * ANAV-01 never touched that list at all.
 */
describe("Todo's destinations stay reachable below the 1200px sidebar breakpoint", () => {
  it("TodoSidebar still links every destination directly, unchanged by the bar's own split", async () => {
    const sidebarHrefs = await renderSidebarHrefs();

    for (const destination of TODO_NAV_DESTINATIONS) {
      expect(sidebarHrefs, `TodoSidebar should link ${destination.to}`).toContain(destination.to);
    }
  });

  it("links every destination from the bar, or from Browse behind the bar's fourth row", async () => {
    const navHrefs = renderNavHrefs();
    const browseHrefs = renderBrowseHrefs();

    for (const destination of TODO_NAV_DESTINATIONS) {
      const reachable = navHrefs.has(destination.to) || browseHrefs.has(destination.to);
      expect(
        reachable,
        `${destination.to} should be reachable from TodoNav's bar or from Browse — it was in neither (bar: ${[...navHrefs].join(", ")}; Browse: ${[...browseHrefs].join(", ")})`,
      ).toBe(true);
    }
  });

  // /todo/projects, /todo/upcoming and /todo/activity specifically —
  // defect 33 and NAV-03's own instances of the class, named directly
  // rather than only covered indirectly by the loop above, so a reader
  // of this file's own history can see exactly which destinations this
  // ticket confirmed reachable. Upcoming stayed on the bar itself;
  // Projects and Activity moved behind Browse — ANAV-01's own trade.
  it("keeps /todo/upcoming reachable from the bar directly", () => {
    const navHrefs = renderNavHrefs();

    expect(navHrefs).toContain("/todo/upcoming");
  });

  it.each(["/todo/projects", "/todo/activity"])("keeps %s reachable from Browse", (to) => {
    const browseHrefs = renderBrowseHrefs();

    expect(browseHrefs).toContain(to);
  });

  // ANAV-01's own regression (todo-page.tsx's own comment on the header
  // Search door): Search had no reachable door at all below the 1200px
  // sidebar breakpoint before this ticket, and is not a
  // `TODO_NAV_DESTINATIONS` entry — Browse is the only door that reaches
  // it below the sidebar breakpoint, so it gets its own direct assertion
  // rather than only riding along in the loop above.
  it("makes /todo/search reachable from Browse", () => {
    const browseHrefs = renderBrowseHrefs();

    expect(browseHrefs).toContain("/todo/search");
  });
});
