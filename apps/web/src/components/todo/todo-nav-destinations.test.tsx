import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
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
 * Both navigations now render from the one list, `TODO_NAV_DESTINATIONS`
 * (todo-nav-destinations.ts) — this test is what stops a future change
 * from re-introducing the old shape (a destination added to one
 * component's own rows and not the other's) rather than to the shared
 * list both read from. It asserts on `href`, not on label text: the two
 * navigations are still free to word a shared destination differently
 * (todo-sidebar.tsx already did, pre-dating this file, for "Filters &
 * Labels" against todo-nav.tsx's plain "Filters" — issue #229/NAV-06, and
 * now again for "Reporting" against "Activity" — parity ledger
 * NAV-01/NAV-11); what must never diverge is which routes exist at all.
 */
describe("TodoNav and TodoSidebar's destination parity", () => {
  it("links every shared destination's href from both navigations", async () => {
    const navHrefs = renderNavHrefs();
    const sidebarHrefs = await renderSidebarHrefs();

    for (const destination of TODO_NAV_DESTINATIONS) {
      expect(navHrefs, `TodoNav should link ${destination.to}`).toContain(destination.to);
      expect(sidebarHrefs, `TodoSidebar should link ${destination.to}`).toContain(destination.to);
    }
  });

  // /todo/projects, /todo/upcoming and /todo/activity specifically —
  // defect 33 and NAV-03's own instances of the class, named directly
  // rather than only covered indirectly by the loop above, so a reader
  // of this file's own history can see exactly which destinations this
  // ticket confirmed reachable from both.
  it.each(["/todo/projects", "/todo/upcoming", "/todo/activity"])(
    "keeps %s reachable from both navigations",
    async (to) => {
      const navHrefs = renderNavHrefs();
      const sidebarHrefs = await renderSidebarHrefs();

      expect(navHrefs).toContain(to);
      expect(sidebarHrefs).toContain(to);
    },
  );
});
