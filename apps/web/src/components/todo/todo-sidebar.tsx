/**
 * Todo's own sidebar — issue #223's second half, the desktop-shaped
 * counterpart to `todo-nav.tsx`'s bottom tab bar. Rendered by
 * `chat-shell-layout.tsx` **in place of** `ChatListPane` in the existing
 * left pane, only while a `/todo/*` route is open, exactly the way that
 * file's own header comment already frames the split: one pane, one
 * width mechanism, whichever content the open route calls for.
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
 * does.** `chat-shell-layout.tsx` renders this pane as a sibling of its
 * own `<Outlet/>`, one level *above* where `EntryStoreLayout` provides
 * `useEntryStore()`'s context (App.tsx: `<Route element={<ChatShellLayout
 * />}><Route element={<EntryStoreLayout />}>…`) — so, unlike everything
 * `todo-page.tsx` renders, this component sits outside that Outlet and
 * cannot call `useEntryStore()` at all (`entry-store-layout.tsx`'s own
 * doc comment on that hook: "anything rendered outside EntryStoreLayout's
 * Outlet must not call this"). `settings-page.tsx` and `use-sync-loop.ts`
 * solved the identical problem for the identical structural reason
 * (Settings is a sibling route, also outside that Outlet) by subscribing
 * to `entryStoreQueryOptions` directly — the same TanStack Query cache
 * `EntryStoreLayout` itself populates, keyed so every subscriber shares
 * one open rather than each triggering its own. This does the same, then
 * reads Tasks/Projects/Filters with the identical query keys
 * `use-tasks.ts`/`use-projects.ts`/`use-filters.ts` use internally, rather
 * than calling those hooks themselves: this component only ever reads —
 * see this file's own header comment above — and those hooks each carry
 * a full mutation surface (`addTask`, `renameProject`, …) this sidebar
 * has no use for and would only be discarding.
 *
 * **Lazy, like every other `/todo/*` chunk.** `chat-shell-layout.tsx`
 * renders unconditionally on every route in the app, `/` included — a
 * static import of this component there would pull `entry-store-layout.tsx`
 * (and everything it drags in) onto the same cold-start path issue #150's
 * lazy boundary exists to keep clear (App.tsx's own header comment), even
 * for a reader who never opens Todo. `React.lazy`, mirroring
 * `todo-page.tsx`'s/`settings-page.tsx`'s own dynamic `import()`, keeps
 * this chunk out of that path entirely.
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
import {
  CalendarCheck,
  CalendarClock,
  History,
  ListFilter,
  ListTodo,
  Plus,
  Search,
} from "lucide-react";
import { NavLink } from "react-router";
import { depthOf } from "@/components/todo/projects-view";
import { localDayKey } from "@/lib/local-day-key";
import {
  FILTERS_QUERY_KEY,
  LABELS_QUERY_KEY,
  PROJECTS_QUERY_KEY,
  TASKS_QUERY_KEY,
} from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { entryStoreQueryOptions } from "@/pages/entry-store-layout";

/** One of the fixed count-carrying rows below `Search` — a `NavLink`, not a plain `Link`, so the reader can see which of Inbox/Today/Upcoming/Filters is the currently open route the same way `chat-list.tsx`'s own rows do. */
function CountRow({
  to,
  label,
  Icon,
  count,
}: {
  to: string;
  label: string;
  Icon: typeof ListTodo;
  count: number;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
          isActive && "bg-muted font-medium",
        )
      }
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      {/* Zero is the ordinary steady state for a fresh Task list — this
          isn't Inbox-zero's own achievement moment (that's TodayView's
          job), so an empty count reads as "nothing to say" and the badge
          is simply absent rather than showing a "0" nobody asked to see. */}
      {count > 0 && <span className="text-muted-foreground text-xs">{count}</span>}
    </NavLink>
  );
}

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

  const now = localDayKey(new Date());
  const inboxCount = tasks.filter((t) => t.projectId === null).length;
  const { overdue, dueToday } = today(tasks, now);
  const todayCount = overdue.length + dueToday.length;
  const upcomingCount = upcoming(tasks, now).reduce((sum, day) => sum + day.tasks.length, 0);

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
      <NavLink
        to="/todo/inbox"
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted"
      >
        <Plus aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        Add task
      </NavLink>
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
        <CountRow to="/todo/inbox" label="Inbox" Icon={ListTodo} count={inboxCount} />
        <CountRow to="/todo/today" label="Today" Icon={CalendarCheck} count={todayCount} />
        <CountRow to="/todo/upcoming" label="Upcoming" Icon={CalendarClock} count={upcomingCount} />
        {/*
          Issue #229's own fix for NAV-06: real Todoist's "Filters &
          Labels" opens one combined screen, and `/todo/filters`
          (filters-view.tsx) now actually is one — its own Filters list
          plus a Labels section underneath, with "Manage Labels" leading
          to the full create/rename/recolour/delete surface
          (`/todo/labels`, `labels-view.tsx`). The count is now Filters
          *and* Labels together, matching what this one destination
          actually shows, rather than the Filters-only count that used to
          silently exclude half of what the row's own name promised.
        */}
        <CountRow
          to="/todo/filters"
          label="Filters & Labels"
          Icon={ListFilter}
          count={filters.length + labels.length}
        />
        {/*
          Issue #248: `todo-nav.tsx` has carried Activity since ADR 0056,
          but that bar hides itself at this same breakpoint (ADR 0076)
          and nothing ever added the identical row here — the same "two
          lists, not one" miss `todo-nav.tsx`'s own header comment records
          for Upcoming, reappearing for Activity instead. `count={0}`
          always: Activity is a log, not something with a pending count the
          way Inbox/Today/Upcoming/Filters have one, so the badge above
          simply never shows for it.
        */}
        <CountRow to="/todo/activity" label="Activity" Icon={History} count={0} />
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
        <h2 className="px-2 py-1 font-medium text-muted-foreground text-xs">Projects</h2>
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
