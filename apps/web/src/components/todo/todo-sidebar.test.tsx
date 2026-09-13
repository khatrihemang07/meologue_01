import type { Filter, Project, Task } from "@meologue/core";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { localDayKey } from "@/lib/local-day-key";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { TodoSidebar } from "./todo-sidebar";

// Computed from the real clock, not pinned with `vi.useFakeTimers()`:
// `entryStoreQueryOptions`'s own promise, and the three dependent
// Tasks/Projects/Filters queries it unlocks, resolve over several real
// microtask/timer hops TanStack Query schedules internally — fake timers
// would freeze those (this suite tried it first; see the git history this
// file replaces), where a real clock lets `findBy*`/`waitFor` do what
// they're built for. Today/Upcoming's own counts are computed relative to
// whichever day this actually runs on instead, the same tradeoff.
const TODAY = localDayKey(new Date());
const TOMORROW = localDayKey(new Date(Date.now() + 24 * 60 * 60 * 1000));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    deviceId: "device-a",
    content: "content",
    completedAt: null,
    orderKey: "V",
    dayOrder: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    date: null,
    deadline: null,
    priority: 1,
    labelIds: [],
    dateString: null,
    projectId: null,
    sectionId: null,
    parentId: null,
    description: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project",
    deviceId: "device-a",
    name: "Errands",
    colour: "#DC4C3E",
    favourite: false,
    archived: false,
    parentId: null,
    description: null,
    orderKey: "V",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function filter(overrides: Partial<Filter> = {}): Filter {
  return {
    id: "filter",
    deviceId: "device-a",
    name: "Due today",
    colour: "#DC4C3E",
    query: "today",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const { openEntryStoreMock } = vi.hoisted(() => ({
  openEntryStoreMock: vi.fn(),
}));

// A stand-in for entry-store-layout.tsx's real entryStoreQueryOptions,
// mirroring settings-page.test.tsx's own mock for the identical structural
// reason this component's own header comment gives: TodoSidebar reads the
// store the same sibling-of-the-Outlet way Settings does, so it needs the
// same test double rather than a real SqliteDriver.
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

function renderSidebar(
  path: string,
  data: { tasks?: Task[]; projects?: Project[]; filters?: Filter[] } = {},
) {
  const { tasks = [], projects = [], filters = [] } = data;
  openEntryStoreMock.mockReset();
  openEntryStoreMock.mockResolvedValue({
    taskStore: { list: () => Promise.resolve(tasks) },
    projectStore: { listProjects: () => Promise.resolve(projects) },
    filterStore: { list: () => Promise.resolve(filters) },
  });
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TodoSidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TodoSidebar", () => {
  it("scopes its landmark to Todo, not the app, mirroring TodoNav's own", () => {
    renderSidebar("/todo/inbox");

    expect(screen.getByRole("navigation")).toHaveAccessibleName("Todo");
  });

  // NAV-07 (parity ledger), issue #260: "Add task" stopped being a link to
  // `/todo/inbox` the moment it started opening the global Quick Add
  // dialog instead of navigating anywhere — Todoist's own sidebar entry
  // does the identical thing (opens Quick Add from wherever the reader
  // already is). It is asserted separately, by role="button", from the
  // five real navigation links below.
  it("offers Add task as a button (not a link) that opens Quick Add from anywhere", async () => {
    renderSidebar("/todo/inbox");
    await screen.findByRole("link", { name: "Inbox" });

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("button", { name: "Add task" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Add task" })).not.toBeInTheDocument();
  });

  it("dispatches OPEN_QUICK_ADD_EVENT when Add task is clicked", async () => {
    const { OPEN_QUICK_ADD_EVENT } = await import("@/lib/todo-keymap");
    const { fireEvent } = await import("@testing-library/react");
    const handler = vi.fn();
    document.addEventListener(OPEN_QUICK_ADD_EVENT, handler);
    try {
      renderSidebar("/todo/inbox");
      await screen.findByRole("link", { name: "Inbox" });

      fireEvent.click(screen.getByRole("button", { name: "Add task" }));

      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener(OPEN_QUICK_ADD_EVENT, handler);
    }
  });

  it("offers Search, Inbox, Today, Upcoming and Filters & Labels as real links, in that order", async () => {
    renderSidebar("/todo/inbox");
    await screen.findByRole("link", { name: "Inbox" });

    const nav = screen.getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    const hrefs = links.slice(0, 5).map((link) => link.getAttribute("href"));

    expect(hrefs).toEqual([
      "/todo/search",
      "/todo/inbox",
      "/todo/today",
      "/todo/upcoming",
      "/todo/filters",
    ]);
  });

  // NAV-01's own fix: the count now lives in aria-label ("Inbox, 9
  // tasks", read live against real Todoist) — aria-label overrides an
  // element's accessible name outright, so this is what `getByRole`'s own
  // `name` option now has to match. The digit stays on screen, hidden from
  // the accessibility tree, so the name never reads "Inbox1".
  it("carries each row's count in aria-label and keeps it on screen, hidden from the name", async () => {
    renderSidebar("/todo/inbox", {
      tasks: [
        task({ id: "in-inbox", projectId: null }),
        task({ id: "filed", projectId: "some-project" }),
        // Both dated Tasks are filed too, so Inbox's own count isn't
        // accidentally inflated by them — Inbox and Today/Upcoming are
        // independent axes (a Task can be dated and filed at once), and
        // this keeps each row's expected count below unambiguous.
        task({ id: "today", date: TODAY, projectId: "some-project" }),
        task({ id: "tomorrow", date: TOMORROW, projectId: "some-project" }),
      ],
      filters: [filter({ id: "f1" }), filter({ id: "f2", name: "Overdue", query: "overdue" })],
    });

    // Inbox: only the undated, unfiled Task counts (1) — `filed` belongs to
    // a Project and isn't in Inbox even though it's also undated. Waited
    // for by its full, counted accessible name rather than a `/^Inbox/`
    // prefix match: the uncounted row also matches that prefix, so
    // `findByRole` would settle the instant the first (count-less) render
    // appears instead of waiting for the count to actually load.
    const inbox = await screen.findByRole("link", { name: "Inbox, 1 task" });
    // The digit is the link's sibling, as Todoist draws it (flow 11 R2).
    expect(inbox).toHaveTextContent(/^Inbox$/);
    const count = within(inbox.parentElement as HTMLElement).getByText("1");
    expect(inbox.contains(count)).toBe(false);
    expect(count).toHaveAttribute("aria-hidden", "true");
    // Today: the one Task dated today.
    expect(screen.getByRole("link", { name: "Today, 1 task" })).toBeInTheDocument();
    // Upcoming: today's own Task and tomorrow's, both — upcoming() starts
    // with today itself (task-views.ts's own doc comment).
    expect(screen.getByRole("link", { name: "Upcoming, 2 tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Filters & Labels, 2 tasks" })).toBeInTheDocument();
  });

  it("omits any digit and any aria-label mentioning a count when it's zero", async () => {
    renderSidebar("/todo/inbox", { tasks: [] });

    const inbox = await screen.findByRole("link", { name: "Inbox" });
    expect(inbox).toHaveTextContent(/^Inbox$/);
    expect(inbox).not.toHaveAttribute("aria-label");
  });

  // Issue #248: `/todo/activity` was reachable from `todo-nav.tsx` (which
  // hides itself at this same breakpoint) and from inside a Project, but
  // never from this sidebar — the identical defect class Upcoming shipped
  // with for a full release (todo-nav.tsx's own header comment). No count
  // badge: Activity is a log, not a pending-work count.
  //
  // Labelled "Reporting", not "Activity" — parity ledger NAV-01/NAV-11,
  // read live against real Todoist (flow 6): Todoist's own word for this
  // destination is "Reporting". todo-nav.tsx's bottom bar still says
  // "Activity" (unmeasured, out of this fix's scope) — the two
  // navigations are free to word a shared destination differently
  // (todo-nav-destinations.ts's own header comment); only the `to` path
  // has to agree.
  it("offers Activity as a real link labelled Reporting, with no count badge", async () => {
    renderSidebar("/todo/inbox");

    expect(await screen.findByRole("link", { name: "Reporting" })).toHaveAttribute(
      "href",
      "/todo/activity",
    );
  });

  it("marks the open route's row aria-current, and no other row", async () => {
    renderSidebar("/todo/today");

    expect(await screen.findByRole("link", { name: "Today" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Upcoming" })).not.toHaveAttribute("aria-current");
  });

  it("lists every non-archived Project, with its own colour as a dot, linking to its own screen", async () => {
    renderSidebar("/todo/inbox", {
      projects: [
        project({ id: "p1", name: "Errands", colour: "#DC4C3E" }),
        project({ id: "p2", name: "Gone", colour: "#369307", archived: true }),
      ],
    });

    expect(await screen.findByRole("link", { name: "Errands" })).toHaveAttribute(
      "href",
      "/todo/projects/p1",
    );
    expect(screen.queryByRole("link", { name: "Gone" })).not.toBeInTheDocument();
  });

  it("indents a nested Project further than its parent", async () => {
    renderSidebar("/todo/inbox", {
      projects: [
        project({ id: "parent", name: "Work", parentId: null }),
        project({ id: "child", name: "Sub-project", parentId: "parent" }),
      ],
    });

    const parentLink = await screen.findByRole("link", { name: "Work" });
    const childLink = screen.getByRole("link", { name: "Sub-project" });
    const parentIndent = Number.parseInt(parentLink.style.paddingLeft, 10);
    const childIndent = Number.parseInt(childLink.style.paddingLeft, 10);

    expect(childIndent).toBeGreaterThan(parentIndent);
  });

  it("lists a favourited Project under Favourites, in addition to the Projects tree", async () => {
    renderSidebar("/todo/inbox", {
      projects: [project({ id: "p1", name: "Errands", favourite: true })],
    });

    await screen.findByRole("heading", { name: "Favourites" });
    // "My Projects" — NAV-01/defect 33's own fix: real Todoist's "My
    // Projects" is a link to /todo/projects, not a bare heading the way
    // meologue's "Projects" used to be, which also happened to be the
    // only instance of defect 33 that wasn't yet covered by a shared-list
    // test: there was no /todo/projects link anywhere at this width.
    expect(screen.getByRole("link", { name: "My Projects" })).toHaveAttribute(
      "href",
      "/todo/projects",
    );
    expect(
      within(screen.getByRole("navigation")).getAllByRole("link", { name: "Errands" }),
    ).toHaveLength(2);
  });

  it("omits the Favourites section entirely when no Project is favourited", async () => {
    renderSidebar("/todo/inbox", {
      projects: [project({ id: "p1", name: "Errands", favourite: false })],
    });

    await screen.findByRole("link", { name: "Errands" });
    expect(screen.queryByRole("heading", { name: "Favourites" })).not.toBeInTheDocument();
  });
});
