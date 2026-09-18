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

  it("keeps /todo/upcoming reachable from the bar directly", () => {
    const navHrefs = renderNavHrefs();

    expect(navHrefs).toContain("/todo/upcoming");
  });

  it.each(["/todo/projects", "/todo/activity"])("keeps %s reachable from Browse", (to) => {
    const browseHrefs = renderBrowseHrefs();

    expect(browseHrefs).toContain(to);
  });

  it("makes /todo/search reachable from Browse", () => {
    const browseHrefs = renderBrowseHrefs();

    expect(browseHrefs).toContain("/todo/search");
  });
});
