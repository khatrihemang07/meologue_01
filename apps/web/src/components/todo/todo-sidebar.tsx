/**
 * Todo's own sidebar — issue #223's second half, the desktop-shaped
 * counterpart to `todo-nav.tsx`'s bottom tab bar. The owner overruled ADR
 * 0076: this no longer replaces `ChatListPane` in `chat-shell-layout.tsx`'s
 * existing pane. `todo-page.tsx` now mounts it directly, as a second column
 * inside Todo's own subtree, only above 1200px (`useTodoSidebarLayout`,
 * `use-wide-layout.ts`) — the chat list pane stays on screen beside it, at
 * every width Todo itself renders through the pane at all.
 *

 * **Navigation only**, deliberately: every row here is a route and a
 * count, nothing more. Creating or renaming a Project belongs to issue
 * #229, not here — the Projects tree below reads `projects` and links
 * into `/todo/projects/:id`, the same screen `todo-nav.tsx`'s own
 * "Projects" row and `projects-view.tsx` already open, rather than this
 * component growing an inline "new Project" form of its own the way
 * `ProjectsView` has one.
 *
 * **Why this reads the Entry store directly, the way `ChatListPane` never
 * does — kept unchanged by the move above, though no longer required by
 * it.** This used to be a sibling of `EntryStoreLayout`'s own `<Outlet/>`,
 * one level *above* where that layout provides `useEntryStore()`'s context
 * (App.tsx: `<Route element={<ChatShellLayout />}><Route
 * element={<EntryStoreLayout />}>…`), so it could not call
 * `useEntryStore()` at all (`entry-store-layout.tsx`'s own doc comment on
 * that hook: "anything rendered outside EntryStoreLayout's Outlet must not
 * call this"). Mounted inside `todo-page.tsx` instead, it now sits *inside*
 * that Outlet the same way every other Todo view does, and could reach
 * `useEntryStore()` directly — this file is not rewired to, since nothing
 * about how it reads Tasks/Projects/Filters needed to change for the
 * mount to move, and doing so anyway would be exactly the refactor-beyond-
 * the-brief this move was scoped not to include. `settings-page.tsx` and
 * `use-sync-loop.ts` solved the original, still-real problem for Settings
 * (a sibling route, still outside that Outlet) by subscribing to
 * `entryStoreQueryOptions` directly — the same TanStack Query cache
 * `EntryStoreLayout` itself populates, keyed so every subscriber shares
 * one open rather than each triggering its own. This does the same, then
 * reads Tasks/Projects/Filters with the identical query keys
 * `use-tasks.ts`/`use-projects.ts`/`use-filters.ts` use internally, rather
 * than calling those hooks themselves: this component only ever reads —
 * see this file's own header comment above — and those hooks each carry
 * a full mutation surface (`addTask`, `renameProject`, …) this sidebar
 * has no use for and would only be discarding.
 *
 * **Lazy, like every other `/todo/*` chunk.** `lazy-todo-sidebar.ts` wraps
 * this in `React.lazy`, mirroring `todo-page.tsx`'s/`settings-page.tsx`'s
 * own dynamic `import()` — a static import here would pull
 * `entry-store-layout.tsx` (and everything it drags in) onto the cold-start
 * path issue #150's lazy boundary exists to keep clear (App.tsx's own
 * header comment), even for a reader who never opens Todo, or who opens it
 * below 1200px where this component never mounts at all.
 *
 * Before the store resolves (a cold render, or a failed open — the
 * `message`/`disabled` state `todo-page.tsx`'s own Shell already
 * surfaces), every count below reads zero and the Projects/Favourites
 * lists read empty rather than this component rendering a second loading
 * state of its own: the rows are still real links to real routes, and
 * `todo-page.tsx`'s own destination already explains a failed open in its
 * own words the moment one of them is opened.
 */
import type { Filter, Label, Project, Task } from "@meologue/core";
import { today, upcoming } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { NavLink } from "react-router";
import { depthOf } from "@/components/todo/projects-view";
import {
  TODO_NAV_DESTINATIONS,
  type TodoNavDestination,
} from "@/components/todo/todo-nav-destinations";
import { localDayKey } from "@/lib/local-day-key";
import {
  FILTERS_QUERY_KEY,
  LABELS_QUERY_KEY,
  PROJECTS_QUERY_KEY,
  TASKS_QUERY_KEY,
} from "@/lib/query-keys";
import { OPEN_QUICK_ADD_EVENT } from "@/lib/todo-keymap";
import { cn } from "@/lib/utils";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";

/**
 * One of the fixed count-carrying rows below `Search` — a `NavLink`, not a
 * plain `Link`, so the reader can see which of Inbox/Today/Upcoming/Filters
 * is the currently open route the same way `chat-list.tsx`'s own rows do.
 *
 * **The count lives in `aria-label`, not in the visible text — NAV-01's
 * own fix.** Real Todoist reads "Inbox, 9 tasks" to a screen reader with
 * nothing in the row's own visible text; meologue used to append a bare
 * digit straight onto the label ("Inbox4"), with no `aria-label` at all.
 * `aria-label` overrides an element's computed accessible name outright,
 * so setting it here is what actually matches Todoist rather than merely
 * adding one alongside the old digit. Zero is the ordinary steady state
 * for a fresh Task list — this isn't Inbox-zero's own achievement moment
 * (that's TodayView's job) — so an empty count reads as "nothing to say":
 * no `aria-label` at all, falling back to the plain visible label.
 *
 * **`dayOfMonth`, Today's row alone.** Real Todoist's Today entry shows
 * the day-of-month where every other row shows its icon — read live, the
 * row's flattened text comes back "12Today" rather than a calendar-check
 * glyph plus the word. This swaps the icon for that numeral when
 * `dayOfMonth` is given, `aria-hidden` like every icon here so it never
 * leaks into the row's `aria-label`-driven accessible name.
 */
function CountRow({
  to,
  label,
  Icon,
  count,
  dayOfMonth,
}: {
  to: string;
  label: string;
  Icon: TodoNavDestination["Icon"];
  count: number;
  dayOfMonth?: number;
}) {
  return (
    <div className="relative">
      <NavLink
        to={to}
        // `replace` (ADR 0079's follow-up, ADR 0086): the sidebar's rows
        // are `todo-nav.tsx`'s own rows rendered at a wider breakpoint,
        // not a second navigation surface with different rules — moving
        // between Todo's own views is interior state there too, so it
        // must not grow the history stack a NavLink pushes by default.
        replace
        aria-label={count > 0 ? `${label}, ${count} ${count === 1 ? "task" : "tasks"}` : undefined}
        className={({ isActive }) =>
          cn(
            "flex items-center gap-2.5 rounded-md py-1.5 pr-8 pl-2 text-sm hover:bg-muted",
            isActive && "bg-muted font-medium",
          )
        }
      >
        {dayOfMonth === undefined ? (
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center text-[10px] text-muted-foreground tabular-nums"
          >
            {dayOfMonth}
          </span>
        )}
        <span className="flex-1 truncate">{label}</span>
      </NavLink>
      {/* The count is the link's sibling, as in Todoist (flow 11 R2), laid
        over the row's right edge so it looks as it did inside the link.
        The link's aria-label ("Inbox, 9 tasks") already names the count;
        aria-hidden keeps the digit from being read twice, and
        pointer-events-none lets a click on it reach the link. */}
      {count > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground text-xs"
        >
          {count}
        </span>
      )}
    </div>
  );
}

// This sidebar's own wording for a shared destination, where it departs
// from todo-nav.tsx's plain label — todo-nav-destinations.ts's own header
// comment: the shared list forecloses drift in *reachability*, not
// prose, so each navigation stays free to render its own words for a
// destination they both link to. "Filters & Labels" predates this ticket
// (issue #229/NAV-06); "Reporting" is this ticket's own fix for parity
// ledger NAV-01/NAV-11 — Todoist's own word for the identical
// destination, read live against the real app (flow 6).
const SIDEBAR_LABELS: Partial<Record<string, string>> = {
  "/todo/filters": "Filters & Labels",
  "/todo/activity": "Reporting",
};

/**
 * A single Project's own row — its colour dot (label-colors.ts's palette,
 * via Project.colour) plus its name, linking to its own screen. Shared by
 * the Favourites section and the Projects tree below rather than each
 * growing its own copy: the two differ only in whether nesting depth is
 * shown (`depth`) — Favourites lists every starred Project flat,
 * regardless of where it nests, since "favourited" is an orthogonal flag
 * a reader reaches for specifically to skip the tree.
 */
function ProjectRow({ project, depth }: { project: Project; depth: number }) {
  return (
    <NavLink
      to={`/todo/projects/${project.id}`}
      // `replace` (ADR 0079's follow-up, ADR 0086): opening one Project
      // from another is still moving between Todo's own views, not
      // leaving Todo, for the identical reason `CountRow`'s own `NavLink`
      // just above does the same.
      replace
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-md py-1.5 pr-2 text-sm hover:bg-muted",
          isActive && "bg-muted font-medium",
        )
      }
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: project.colour }}
      />
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
    </NavLink>
  );
}

export function TodoSidebar() {
  const storeQuery = useQuery(entryStoreQueryOptions);
  const opened = storeQuery.data;

  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: (): Promise<Task[]> => opened?.taskStore.list() ?? Promise.resolve([]),
    enabled: opened !== undefined,
  });
  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: (): Promise<Project[]> => opened?.projectStore.listProjects() ?? Promise.resolve([]),
    enabled: opened !== undefined,
  });
  const filtersQuery = useQuery({
    queryKey: FILTERS_QUERY_KEY,
    queryFn: (): Promise<Filter[]> => opened?.filterStore.list() ?? Promise.resolve([]),
    enabled: opened !== undefined,
  });
  // Issue #229: NAV-06's own fix — "Filters & Labels" now has a real
  // Labels destination (`/todo/labels`, `labels-view.tsx`) to count
  // against, not only Filters.
  const labelsQuery = useQuery({
    queryKey: LABELS_QUERY_KEY,
    queryFn: (): Promise<Label[]> => opened?.labelStore.list() ?? Promise.resolve([]),
    enabled: opened !== undefined,
  });

  const tasks = tasksQuery.data ?? [];
  const projects = projectsQuery.data ?? [];
  const filters = filtersQuery.data ?? [];
  const labels = labelsQuery.data ?? [];

  const nowDate = new Date();
  const now = localDayKey(nowDate);
  const inboxCount = tasks.filter((t) => t.projectId === null).length;
  const { overdue, dueToday } = today(tasks, now);
  const todayCount = overdue.length + dueToday.length;
  const upcomingCount = upcoming(tasks, now).reduce((sum, day) => sum + day.tasks.length, 0);

  // Each shared destination's own count, keyed by its `to` path so the
  // render below can read TODO_NAV_DESTINATIONS in one pass instead of a
  // hand-written CountRow per destination — the same per-destination data
  // this file always computed, just no longer copy-pasted once per row.
  // "/todo/activity" always reads 0: Activity is a log, not something
  // with a pending count the way Inbox/Today/Upcoming/Filters have one.
  const countsByPath: Partial<Record<string, number>> = {
    "/todo/inbox": inboxCount,
    "/todo/today": todayCount,
    "/todo/upcoming": upcomingCount,
    // Issue #229's own fix for NAV-06: real Todoist's "Filters & Labels"
    // opens one combined screen, and `/todo/filters` (filters-view.tsx)
    // now actually is one — its own Filters list plus a Labels section
    // underneath. The count is Filters *and* Labels together, matching
    // what this one destination actually shows.
    "/todo/filters": filters.length + labels.length,
    "/todo/activity": 0,
  };

  const byId = new Map(projects.map((project) => [project.id, project] as const));
  // Archived Projects drop out of the sidebar entirely, mirroring real
  // Todoist's own sidebar (an archived Project stays reachable from
  // `/todo/projects`'s full list, `projects-view.tsx`, which — unlike this
  // nav — has always shown archived rows so a reader can unarchive one).
  const activeProjects = projects.filter((project) => !project.archived);
  const favouriteProjects = activeProjects.filter((project) => project.favourite);

  return (
    /*
      `bg-muted` and an explicit 13px, both measured rather than chosen.
      Todoist paints its sidebar rgb(38,38,38) against a rgb(31,31,31)
      content pane — the secondary surface reading *lighter* than the page,
      which is the inversion index.css's `[data-surface="todo"]` block
      records — and sets its chrome a pixel smaller than the row text
      (`--td-chrome-font-size`, 13px) rather than sharing one body size.
      Without the background this pane inherits the content colour and the
      two columns melt into one; the parity ledger's THEME-02 is what that
      would have quietly failed.
    */
    <nav
      aria-label="Todo"
      className="flex h-full flex-col gap-1 overflow-y-auto bg-muted p-2 text-[length:var(--td-chrome-font-size)]"
    >
      {/*
        NAV-07 (parity ledger), issue #260: this used to be a `NavLink` to
        `/todo/inbox` — "the add field is *at* Inbox" was the old model.
        Todoist's own sidebar "Add task" opens the global Quick Add dialog
        from wherever the reader already is, not a navigation — so this is
        now a plain button dispatching `OPEN_QUICK_ADD_EVENT`
        (`todo-keymap.ts`'s own doc comment on that constant has the full
        fan-in reasoning). This component sits outside `EntryStoreLayout`'s
        Outlet (this file's own header comment) and has no `handleAdd` of
        its own to call — `todo-page.tsx`, which does, is the listener.
      */}
      <button
        type="button"
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
        onClick={() => document.dispatchEvent(new CustomEvent(OPEN_QUICK_ADD_EVENT))}
      >
        <Plus aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        Add task
      </button>
      <NavLink
        to="/todo/search"
        className={({ isActive }) =>
          cn(
            "flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted",
            isActive && "bg-muted font-medium",
          )
        }
      >
        <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        Search
      </NavLink>

      <div className="mt-1 flex flex-col gap-0.5">
        {/*
          Every flat, single-view destination except Projects — driven by
          TODO_NAV_DESTINATIONS, the same list todo-nav.tsx renders from,
          so this sidebar can no longer drift from it the way it did for
          Upcoming (issue #223) and Activity (issue #248) before this
          ticket. Projects is excluded: this sidebar reaches it through
          the "My Projects" heading and tree below, not a CountRow.
        */}
        {TODO_NAV_DESTINATIONS.filter((destination) => destination.to !== "/todo/projects").map(
          (destination) => (
            <CountRow
              key={destination.to}
              to={destination.to}
              label={SIDEBAR_LABELS[destination.to] ?? destination.label}
              Icon={destination.Icon}
              count={countsByPath[destination.to] ?? 0}
              dayOfMonth={destination.to === "/todo/today" ? nowDate.getDate() : undefined}
            />
          ),
        )}
      </div>

      {favouriteProjects.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5">
          <h2 className="px-2 py-1 font-medium text-muted-foreground text-xs">Favourites</h2>
          {favouriteProjects.map((project) => (
            <ProjectRow key={project.id} project={project} depth={0} />
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-0.5">
        {/*
          Parity ledger NAV-01/defect 33: real Todoist's "My Projects" is a
          link to its own projects page, not a bare heading — meologue's
          "Projects" heading here was the desktop-only instance of defect
          33 (no `/todo/projects` link anywhere ≥900px, since todo-nav.tsx
          hides itself at that width), on top of the wording gap NAV-01
          measured live. A plain `to="/todo/projects"` rather than reading
          TODO_NAV_DESTINATIONS: the shared list exists to keep both
          navigations' *sets* of destinations from drifting, not to source
          every literal href in either component.
        */}
        <NavLink
          to="/todo/projects"
          className={({ isActive }) =>
            cn(
              "rounded-md px-2 py-1 font-medium text-muted-foreground text-xs hover:text-foreground",
              isActive && "text-foreground",
            )
          }
        >
          My Projects
        </NavLink>
        {activeProjects.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-xs">
            No Projects yet — add one from the Projects list.
          </p>
        ) : (
          activeProjects.map((project) => (
            <ProjectRow key={project.id} project={project} depth={depthOf(project, byId)} />
          ))
        )}
      </div>
    </nav>
  );
}
