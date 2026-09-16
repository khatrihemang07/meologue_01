import type { Filter, Project, Section, Task } from "@meologue/core";
import { today, upcoming } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { inlineProse } from "@/components/inline-prose";
import { Shell } from "@/components/shell";
import { ActivityFeed } from "@/components/todo/activity-feed";
import { AddTaskForm } from "@/components/todo/add-task-form";
import { CompletionToastBody } from "@/components/todo/completion-toast";
import { FilterView } from "@/components/todo/filter-view";
import { FiltersView } from "@/components/todo/filters-view";
import { LabelsView } from "@/components/todo/labels-view";
import { LazyTaskDetailView } from "@/components/todo/lazy-task-detail-view";
import { LazyTaskScheduleSheet } from "@/components/todo/lazy-task-schedule-sheet";
import { ProjectView } from "@/components/todo/project-view";
import { ProjectsView } from "@/components/todo/projects-view";
import { QuickAddDialog } from "@/components/todo/quick-add-dialog";
import { TaskList } from "@/components/todo/task-list";
import { TaskQuickFind } from "@/components/todo/task-quick-find";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { TaskSearchPage } from "@/components/todo/task-search-page";
import { TodayView } from "@/components/todo/today-view";
import { TodoCreateFab } from "@/components/todo/todo-create-fab";
import { TodoKeyboardShortcutsOverlay } from "@/components/todo/todo-keyboard-shortcuts-overlay";
import { TodoNav } from "@/components/todo/todo-nav";
import { UpcomingView } from "@/components/todo/upcoming-view";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { useTodoKeymap } from "@/hooks/use-todo-keymap";
import { useWideLayout } from "@/hooks/use-wide-layout";
import { commentCountForTask, commentsForTask } from "@/lib/comment-counts";
import { localDayKey } from "@/lib/local-day-key";
import { sectionsQueryKey, tasksInProjectQueryKey } from "@/lib/query-keys";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { useSettingsStore } from "@/lib/settings";
import { hasCommentReplyIntent, taskDetailPath, taskIdFromParam } from "@/lib/task-detail-route";
import { commitTaskTitle } from "@/lib/task-title-commit";
import { OPEN_QUICK_ADD_EVENT } from "@/lib/todo-keymap";
import { useEntryStore } from "@/pages/entry-store-layout";

/**
 * Which of Todo's non-Task views is rendered *behind* the Task detail
 * modal/sheet (issue #178) — computed once (`backgroundView` below) and
 * used for two things: which of Inbox/Today/Projects/a Project's own
 * screen this page actually renders while `/todo/task/:taskSlugId` is
 * open, and which list `prevTask`/`nextTask` step through. Every
 * `openTaskDetail` call (`TaskDetailActions.onOpenDetail`, passed to
 * every row on this page) carries the *current* one of these as
 * `location.state.from`, so opening a Task's own view remembers where it
 * was opened from without this page needing a second route per
 * background view the way `App.tsx`'s four `view`-driven routes already
 * are one per view.
 */
interface TodoBackgroundView {
  view:
    | "inbox"
    | "today"
    | "upcoming"
    | "projects"
    | "project"
    | "search"
    | "activity"
    | "filters"
    | "filter"
    | "labels";
  projectId: string | null;
  /**
   * The Filter this Task was opened from a result of, for `view ===
   * "filter"` — `null` means `/todo/filters/new` (a Task opened from a
   * still-unsaved query's own live preview), mirroring `projectId`'s own
   * "which one" role for `view === "project"`.
   */
  filterId?: string | null;
  /**
   * The full search page's own `?q=…&tab=…` (issue #183) — `undefined`
   * for every other view. Carried here, not recovered from `window.
   * location` on close, so a Task opened from a search result and then
   * closed lands back on the exact same query and tab rather than a bare
   * `/todo/search`.
   */
  search?: string;
}

function backgroundPath(background: TodoBackgroundView): string {
  if (background.view === "project") {
    return background.projectId === null
      ? "/todo/projects"
      : `/todo/projects/${background.projectId}`;
  }
  if (background.view === "filter") {
    return background.filterId === null || background.filterId === undefined
      ? "/todo/filters/new"
      : `/todo/filters/${background.filterId}`;
  }
  if (background.view === "search") {
    return `/todo/search${background.search ?? ""}`;
  }
  if (background.view === "activity") {
    return `/todo/activity${background.search ?? ""}`;
  }
  return `/todo/${background.view}`;
}

/**
 * Issue #254: the in-column heading's text for every `TodoBackgroundView`
 * that isn't a Project's or a Filter's own (those two read their resolved
 * `name` instead — see `todoHeading` below). Covers every view Shell's
 * `hideAppBar` chrome now renders for, not only the four the ticket names
 * explicitly (Inbox/Today/Upcoming/a Project's or Filter's own name):
 * Todo's app bar is gone for the whole Destination, not gated per view, so
 * every view needs *some* heading rather than the four unnamed ones
 * falling back to nothing. Wording follows this app's own existing
 * surfaces where one already exists — `todo-sidebar.tsx`'s row labels for
 * "Filters & Labels", `todo-nav.tsx`'s "Activity" — rather than inventing
 * new copy.
 */
const VIEW_HEADINGS: Record<Exclude<TodoBackgroundView["view"], "project" | "filter">, string> = {
  inbox: "Inbox",
  today: "Today",
  upcoming: "Upcoming",
  projects: "Projects",
  search: "Search",
  activity: "Activity",
  filters: "Filters & Labels",
  labels: "Labels",
};

/**
 * CMT-05 (parity ledger) — how long a completion toast stays up, measured
 * live rather than trusted from `meologue-parity-docs/todoist/lifecycle.md`'s own
 * once-coarse estimate. That doc's "6-8 seconds" came from 2-second polling
 * and doesn't reproduce; a 300ms re-poll (flow 5,
 * `meologue-parity-docs/todoist/live-audit-dom/flow5-CMT-05-todoist.json`) found
 * Todoist's own toast still present at 10,775ms and gone by 11,081ms.
 * meologue's matching toast (`flow5-CMT-05-meologue.json`) was gone between
 * 4,346ms and 4,651ms — sonner's own unconfigured default, not a value
 * anyone chose. ADR 0077 makes the live reading the reference over the
 * dated capture, so this targets Todoist's measured ~11s rather than the
 * ledger row's own nuance text.
 *
 * **Corrected to 10s by flow 11 R3 (Sun 13 Sep).** Measured from when the
 * toast *appears*, both Todoist readings are about 10s plus an exit animation:
 * flow 5 first saw it at 360ms, gone 10,775–11,081ms; R3 at 388ms, gone
 * 10,469–10,774ms, so "~11s" folded the appearance delay and the exit into
 * the duration. R3 read meologue at 11s as gone 11,068–11,372ms, about
 * 600ms late. Todoist's "Date updated" toast (DET-16) reads the same ~10s, and meologue's 10s copy
 * of it landed within 50ms of Todoist's in the same session.
 *
 * Applied to the two completion toasts below only (`handleComplete`,
 * `handleCompleteForever`) — every other toast on this page (`copyTaskLink`'s
 * "Link copied", the error toasts) keeps sonner's default, unmeasured and
 * unaffected by this ticket.
 */
const COMPLETION_TOAST_DURATION_MS = 10_000;

/**
 * A Project's or a Filter's own resolved name (acceptance criterion: "The
 * heading reflects the current view, including a Project's or Filter's own
 * name"). `project`/`filter` are looked up by the caller (`currentProject`/
 * `currentFilter` below, already resolved for the row highlighting and
 * breadcrumbs elsewhere on this page) rather than re-found here, so this
 * stays a pure mapping with no store access of its own. `null` — the id
 * hasn't resolved yet, or `/todo/filters/new` — falls back to a generic
 * label rather than rendering an empty `<h1>`.
 */
function todoHeading(
  background: TodoBackgroundView,
  project: Project | null,
  filter: Filter | null,
): string {
  if (background.view === "project") {
    return project?.name ?? "Project";
  }
  if (background.view === "filter") {
    return filter?.name ?? "New filter";
  }
  return VIEW_HEADINGS[background.view];
}

export interface TodoPageProps {
  /**
   * Which of Todo's views to render — a prop, not a lazily-imported page
   * per view, so `App.tsx` keeps exactly one dynamic
   * `import("@/pages/todo-page")` regardless of how many `/todo/*` routes
   * exist (issue #169's own doc comment on why, extended by issue #171's
   * two new views rather than a second chunk: "Todo's route budget will
   * grow" is this ticket's own brief, singular — one chunk, one budget
   * entry, `check-bundle-size.mjs`'s own `CHUNK_BUDGETS["src/pages/
   * todo-page.tsx"]`). Defaults to "inbox" so every pre-#169 caller keeps
   * working unchanged.
   *
   * `"project"` reads which Project from the route itself
   * (`useParams<{ projectId: string }>()` below), the same way
   * `/reflect/:sessionId` reads its own id — not a second prop, since the
   * id is already in the URL a bookmark or a reload has to survive.
   */
  view?:
    | "inbox"
    | "today"
    | "upcoming"
    | "projects"
    | "project"
    | "search"
    | "activity"
    | "filters"
    | "filter"
    | "labels";
}

/**
 * Todo's four views (issue #168's Inbox, issue #169's Today, issue #171's
 * Projects list and one Project's own screen) — ADR 0049 names every
 * `/todo/*` route as rendered through this one lazy chunk, and this
 * component is the seam that picks between them via `view` rather than
 * each view owning its own page module.
 *
 * Inbox and a Project's own view **share one list component**
 * (`components/todo/task-list.tsx`) — issue #171's own acceptance
 * criterion, "opening a Project lists its Tasks, reusing the list Inbox
 * already uses" — rather than either being a second implementation of
 * drag/keyboard reorder. Both read `TaskStore.listByProject` (via
 * `listTasksInProject`, use-tasks.ts), `projectId: null` meaning Inbox:
 * before this ticket Inbox read the flat, cross-Project `tasks` array
 * (TaskStore.list()), which now means "every Task everywhere," not
 * "Inbox" — see that field's own doc comment (entry-store-layout.tsx) for
 * why its meaning stays global rather than narrowing. Today keeps reading
 * the flat `tasks` array, unchanged: it is a cross-Project view by design
 * (a dated Task shows up there regardless of which Project or Inbox it
 * lives in), and it still has no drag-to-reorder of its own — task-views.ts's
 * `today()` computes its order.
 *
 * Renders through `Shell` the same way every other Destination does,
 * `composerSlot={<TodoNav />}` docking Todo's own internal navigation at
 * the pane's bottom edge, regardless of which view is open.
 * `floatingAction={<TodoCreateFab />}` (issue #304) rides alongside it —
 * both unconditional here, per-view scoping (narrow-only, "wide" hides
 * both) lives in `TodoNav`/`TodoCreateFab` themselves, the same "Add task"
 * door `todo-sidebar.tsx`'s own reaches from anywhere in Todo, not a
 * per-view one.
 *
 * The Add form, the delete confirmation, and the schedule sheet are all
 * owned here, once, and shared by every view that needs them rather than
 * each growing its own copy — deleting or scheduling a Task is the
 * identical act regardless of which view's row a reader tapped it from,
 * and `confirmingTask`/`schedulingTask` below are looked up against the
 * flat `tasks` array precisely because that array still holds every Task
 * anywhere (its own doc comment, above), so one lookup works for a row
 * from any view without this component needing to know which scope it
 * came from.
 *
 * ROW-14 (parity-ledger.md), the user's 2026-09-13 decision to match
 * Todoist: there is no Completed disclosure here any more.
 * `completed-tasks.tsx` used to be exactly that — a separate, collapsed
 * `<details>` this page rendered once, below Inbox's own list — and this
 * page's own `completedTasks` (from `useEntryStore()`) now instead flows
 * straight into `TaskList`/`ProjectView`, which interleave each completed
 * Task inline, in place, alongside the active siblings it belongs among
 * (`task-tree.tsx`'s own doc comment on the merge). `handleUncompleteTask`
 * below is the one new door this page adds — the task-shaped callback
 * `TaskList`'s own `onUncomplete` prop calls, adapting the store's
 * id-based `uncompleteTask` the identical way `handleCompleteTask` already
 * adapts `handleComplete`.
 *
 * The Add form is shared too, but it is **not** context-free — see
 * `captureDate`/`captureProjectId` below. It renders once, but not first:
 * issue #252 moved its render to just before the Completed disclosure that
 * used to sit here (near the bottom of the JSX below) so it lands after
 * whichever list is on screen rather than above it, matching Todoist's own
 * end-of-list "+ Add task" row (NAV-10, parity ledger) — position only,
 * and unaffected by that disclosure's own later removal: the list itself
 * is still whatever's on screen, now just interleaved rather than
 * followed by a second block. The elements themselves are unchanged: the
 * field stays always-mounted and the Add button stays rendered-but-
 * disabled rather than either unmounting until a click, the click-to-
 * reveal composer with its own pickers being a deliberately deferred,
 * separate ticket (NAV-12, parity ledger).
 */
export function TodoPage({ view = "inbox" }: TodoPageProps = {}) {
  const {
    projectId: routeProjectId,
    filterId: routeFilterId,
    taskSlugId,
  } = useParams<{
    projectId: string;
    filterId: string;
    taskSlugId: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  // Issue #307: gates the header Search door below — TodoSidebar (rendered
  // by chat-shell-layout.tsx in place of the chat list, ADR 0076) already
  // carries its own working `/todo/search` link at this same breakpoint
  // (todo-sidebar.tsx), so rendering a second one here at ≥900px would be
  // the identical duplicate-affordance shape todo-nav.tsx's own header
  // comment already avoids for its `<nav>` landmark.
  const wide = useWideLayout();
  // Issue #306: `?intent=reply` (a Task row's comment badge,
  // `taskDetailPath`'s own `commentIntent` option) read back out of the
  // current URL — `openCommentComposer` below is this page's one use of
  // it, threaded down to `TaskDetailView`.
  const [searchParams] = useSearchParams();

  // Which background view renders *behind* the Task detail modal/sheet —
  // this file's own header comment on `TodoBackgroundView`/`backgroundPath`
  // explains why `/todo/task/:taskSlugId` (App.tsx) passes no `view` prop
  // of its own and reads this from `location.state` instead. A direct
  // link or a reload of a Task's own address carries no such state (there
  // was no "opened from" navigation to remember), so it falls back to
  // Inbox — the identical fallback `/todo` itself redirects to
  // (App.tsx's own `<Navigate to="/todo/inbox" />`), rather than this
  // page inventing a second "nothing chosen" default.
  const backgroundView: TodoBackgroundView =
    taskSlugId !== undefined
      ? ((location.state as { from?: TodoBackgroundView } | null)?.from ?? {
          view: "inbox",
          projectId: null,
        })
      : {
          view,
          projectId: view === "project" ? (routeProjectId ?? null) : null,
          filterId: view === "filter" ? (routeFilterId ?? null) : null,
          search: view === "search" || view === "activity" ? location.search : undefined,
        };
  const currentProjectId = backgroundView.projectId;
  const currentFilterId = backgroundView.filterId ?? null;

  const {
    tasks,
    completedTasks,
    addTask,
    completeTask,
    uncompleteTask,
    renameTask,
    reorderTask,
    removeTask,
    disabled,
    message,
    messageAction,
    setTaskDate,
    setTaskDeadline,
    setTaskPriority,
    setTaskDateString,
    setTaskLabels,
    listTasksInProject,
    listTaskChildren,
    countTaskChildren,
    listTasksInSection,
    listTaskDescendants,
    advanceRecurringTask,
    completeForeverTask,
    setTaskProject,
    setTaskParent,
    setTaskSection,
    setTaskDescription,
    labels,
    addLabel,
    renameLabel,
    setLabelColour,
    removeLabel,
    resolveLabelIds,
    comments,
    addComment,
    editComment,
    removeComment,
    projects,
    addProject,
    renameProject,
    setProjectColour,
    setProjectDescription,
    setProjectFavourite,
    archiveProject,
    unarchiveProject,
    setProjectParent,
    removeProject,
    listSections,
    addSection,
    renameSection,
    reorderSection,
    deleteSection,
    archiveSection,
    unarchiveSection,
    events,
    filters,
    addFilter,
    renameFilter,
    setFilterColour,
    setFilterQuery,
    removeFilter,
  } = useEntryStore();

  // The default date/Project a Task captured *from this view* inherits —
  // the plan's "default date is inherited from origin" rule, Todoist's own
  // context inheritance, applied to `date` since issue #169 and to
  // `projectId` since this ticket. Inbox is the undated, unfiled capture
  // bucket, so it inherits neither; Today inherits today's date (and
  // nothing about a Project — Today is cross-Project, this ticket's own
  // header comment above); a Project's own view inherits that Project.
  //
  // `date`'s own history is why this isn't a nicety: with Inbox's rule
  // applied to Today too, a Task added while standing on Today used to
  // disappear as it was typed (this file's own git history — see the
  // pre-#171 version of this comment). `projectId` gets the identical
  // treatment on the same reasoning: a Task added from a Project's own
  // "Add a Task" field that silently landed in Inbox instead would be the
  // structural equivalent of that same bug.
  const captureDate = backgroundView.view === "today" ? localDayKey(new Date()) : null;
  const captureProjectId = backgroundView.view === "project" ? currentProjectId : null;

  // Inbox's and a Project's own top-level Tasks (TaskStore.listByProject,
  // `null` meaning Inbox) — this component's own header comment on why
  // this replaced the flat `tasks` array for these two views specifically.
  // `enabled` skips the fetch entirely for Today/Projects, which have no
  // use for it.
  const scopeProjectId = backgroundView.view === "inbox" ? null : currentProjectId;
  const scopedTasksQuery = useQuery({
    queryKey: tasksInProjectQueryKey(scopeProjectId),
    queryFn: () => listTasksInProject(scopeProjectId),
    enabled:
      backgroundView.view === "inbox" ||
      (backgroundView.view === "project" && currentProjectId !== null),
  });
  const scopedTasks = scopedTasksQuery.data ?? [];

  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
  const currentFilter = filters.find((filter) => filter.id === currentFilterId) ?? null;

  const sectionsQuery = useQuery({
    queryKey: sectionsQueryKey(currentProjectId ?? ""),
    queryFn: () => listSections(currentProjectId as string),
    enabled: backgroundView.view === "project" && currentProjectId !== null,
  });
  const sections = sectionsQuery.data ?? [];

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmingTask = tasks.find((task) => task.id === confirmingId) ?? null;

  // Issue #228: Quick-find's own `open` state, lifted here from
  // task-quick-find.tsx (that file's own header comment on why) — driven
  // by `/`/`f`/⌘K through `useTodoKeymap` below, the identical "controlled
  // from the page" shape `schedulingId`/`confirmingId` already use. The
  // `?` shortcuts overlay gets the same treatment, one state each, since
  // neither owns a document listener of its own any more.
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Issue #260 (NAV-07, parity ledger): the global Quick Add dialog's own
  // `open` state, the identical "controlled from the page" shape
  // `quickFindOpen`/`shortcutsOpen` above already use. Two different
  // triggers ask for it — `Q` via `useTodoKeymap` below (dispatched as
  // `OPEN_QUICK_ADD_EVENT`, `use-todo-keymap.ts`'s own `quick-add` case)
  // and `todo-sidebar.tsx`'s "Add task" button, which dispatches the
  // identical event directly since that component sits outside this
  // page's own Outlet and has no other door in. One listener here answers
  // both.
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  useEffect(() => {
    function handleOpenQuickAdd() {
      setQuickAddOpen(true);
    }
    document.addEventListener(OPEN_QUICK_ADD_EVENT, handleOpenQuickAdd);
    return () => document.removeEventListener(OPEN_QUICK_ADD_EVENT, handleOpenQuickAdd);
  }, []);

  // CMT-05 (parity ledger) — the one thing `Z`/`⌘Z` (`use-todo-keymap.ts`'s
  // `undo-complete` binding) has to act on: the most recent completion's
  // own `uncompleteTask` call, live only while its toast is still showing.
  // A `ref`, not `useState`, deliberately — this never drives a render,
  // only `fire()`'s later, out-of-band read of it, the same reason
  // `document.activeElement` (`focusedTaskId()`, todo-keymap.ts) is read
  // fresh rather than tracked in state. `toastId` guards against a stale
  // write: if a second completion happens before the first toast's
  // `onAutoClose`/`onDismiss` fires, that older callback must not clear
  // the ref out from under the newer completion it no longer describes.
  const pendingUndoRef = useRef<{ toastId: string | number; undo: () => void } | null>(null);

  /** The one place a completion toast is raised (`handleComplete`,
   * `handleCompleteForever` below share it) — the toast's own "Undo"
   * button and the `undo-complete` keyboard binding both end up calling
   * the identical `undo` callback, so there is exactly one way a
   * completion gets reversed, not two implementations that could drift.
   * `duration`/`onAutoClose`/`onDismiss` are the CMT-05 pieces: a 10s
   * lifetime (`COMPLETION_TOAST_DURATION_MS`'s own doc comment has the
   * measurement) and clearing `pendingUndoRef` the moment this exact toast
   * stops being on screen, by either path sonner offers for "it's gone."
   *
   * CMT-04 (parity ledger): `toast.custom()` in place of the plain
   * `toast(message, {...})` this used before — `completion-toast.tsx`'s
   * own header comment has the full reasoning (sonner exposes no `role`
   * option; `toast.custom()` is its documented escape hatch). The Undo
   * button now lives inside that custom body rather than being sonner's
   * own `action`, so its `onClick` has to do both things `action.onClick`
   * used to get for free: run `undo`, then dismiss the toast itself
   * (`toast.dismiss(id)`, the same id `toast.custom` handed the jsx
   * callback and returned here) — sonner's own action button dismissed
   * automatically after `onClick`; a bare custom button does not. */
  function raiseCompletionToast(taskId: string, message: string) {
    const undo = () => {
      uncompleteTask(taskId);
      pendingUndoRef.current = null;
    };
    const toastId = toast.custom(
      (id) => (
        <CompletionToastBody
          message={message}
          onUndo={() => {
            undo();
            toast.dismiss(id);
          }}
        />
      ),
      {
        duration: COMPLETION_TOAST_DURATION_MS,
        onAutoClose: () => {
          if (pendingUndoRef.current?.toastId === toastId) {
            pendingUndoRef.current = null;
          }
        },
        onDismiss: () => {
          if (pendingUndoRef.current?.toastId === toastId) {
            pendingUndoRef.current = null;
          }
        },
      },
    );
    pendingUndoRef.current = { toastId, undo };
  }

  // Issue #184: "completed work is reached by narrowing the log to
  // completions, not from a separate destination of its own" — a plain
  // toggle above the Activity view rather than a second route.

  // The one TaskScheduleSheet instance for the whole page (this
  // component's own doc comment) — `schedulingId` names which Task it's
  // currently open for, `null` meaning closed. Looked up fresh from
  // `tasks` on every render (`schedulingTask` below) rather than a
  // snapshot captured when the sheet opened, so a picker's own write is
  // visible in the sheet the instant the next render lands (TanStack
  // Query's cache update after `afterLocalWrite`, use-tasks.ts).
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const schedulingTask = tasks.find((task) => task.id === schedulingId) ?? null;

  function handleOpenSchedule(taskId: string) {
    setSchedulingId(taskId);
  }

  // Day-keys carrying at least one active Task, mapped to how many —
  // TaskSchedulePopover's own doc comment on why SCHED-09's calendar dot
  // and SCHED-04's preview subline share this one source rather than two
  // independently-computed counts. Recomputed only when `tasks` itself
  // changes, not on every render the schedule sheet happens to be open
  // for — every Task in the list counts, including the one currently
  // being scheduled, matching how a real calendar dot would read "how
  // many Tasks land here" regardless of which one opened the picker.
  const datesWithTasks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (task.date === null) {
        continue;
      }
      const day = task.date.slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);

  // Completing raises the same Undo-toast affordance
  // register-service-worker.web.ts's own update prompt uses
  // (`toast(..., { action: { label, onClick } })`), mirroring that shape
  // rather than inventing a second one for this app to carry.
  //
  // This does not reopen issue #82's removal of undo-on-delete. That
  // removal exists because an Entry delete is terminal at the id level —
  // use-history.ts's own long comment on `removeEntry` explains that the
  // Server's `on conflict ... where entries.deleted_at is null` guard makes
  // reviving a deleted id impossible, so a "restore" would have to mint a
  // fresh id and diverge permanently from what every other Device already
  // converged on. Completing a Task is a different act entirely: the row
  // is not deleted, not tombstoned, not even touched at the id level —
  // `uncomplete()` just clears `completedAt` and clears `seq` the same way
  // any other edit does, and it Syncs like any other write. There is
  // nothing here for "permanently diverges" to mean.
  // `dateString` decides which mutation "completing" actually means
  // (issue #170): a recurring Task (`dateString !== null`) never enters
  // the completed list at all (TaskStore.advanceRecurring's own doc
  // comment — "the checkbox does not un-tick itself"), so there is
  // nothing here for the Undo toast to reverse and none is offered; the
  // row itself already shows the next occurrence the moment this
  // component re-renders.
  // CMT-04 (parity ledger) — Todoist's own wording is task-agnostic and
  // count-based ("1 task completed"), not `Completed "<name>"`; matched
  // verbatim rather than kept as the more informative original. `content`
  // stays in the signature even though this branch no longer reads it:
  // `onComplete` below is bound directly to this function, and its shared
  // type (task-row-content.tsx/task-row.tsx, outside this ticket) still
  // passes it.
  function handleComplete(taskId: string, _content: string, dateString: string | null) {
    if (dateString !== null) {
      advanceRecurringTask(taskId);
      return;
    }
    completeTask(taskId);
    raiseCompletionToast(taskId, "1 task completed");
  }

  // Ends a recurring Task's series (TaskStore.completeForever's own doc
  // comment) — reached via Shift+Click on the checkbox or the touch-
  // reachable button (task-row.tsx). Undo is still offered — `uncomplete()`
  // clears `completedAt` unconditionally — but it only restores an
  // ordinary, non-recurring active Task: `completeForever` also clears
  // `dateString` for good, and undoing a completion has never been this
  // programme's mechanism for restoring a rule that was deliberately
  // ended (`uncomplete`'s own doc comment never claims otherwise). The
  // toast's own wording says so, rather than promising more than Undo
  // actually gives back.
  //
  // CMT-04 (parity ledger): "1 task completed" replaces this row's own
  // `Completed "<name>"`, matching `handleComplete` above — Todoist's own
  // wording, verbatim. Todoist has no equivalent "series ended" variant to
  // match against, so " — the recurrence has ended" is kept, appended to
  // the same base, rather than dropped: losing it would silently hide the
  // one piece of information this toast alone carries. `content` stays
  // in the signature for the same shared-callback reason as
  // `handleComplete`'s own comment above.
  function handleCompleteForever(taskId: string, _content: string) {
    completeForeverTask(taskId);
    raiseCompletionToast(taskId, "1 task completed — the recurrence has ended");
  }

  function handleRequestDelete(taskId: string) {
    setConfirmingId(taskId);
  }

  // TaskList/TaskTree's own callbacks are `(task: Task) => void` — they
  // already have the whole Task in hand from rendering its own row, so
  // there's nothing for them to look up. These three adapt this page's
  // existing id-based handlers (above, still used directly by TodayView,
  // which is unchanged from issue #169) to that shape rather than this
  // page growing a second copy of each.
  function handleCompleteTask(task: Task) {
    handleComplete(task.id, task.content, task.dateString);
  }

  function handleCompleteForeverTask(task: Task) {
    handleCompleteForever(task.id, task.content);
  }

  function handleRequestDeleteTask(task: Task) {
    handleRequestDelete(task.id);
  }

  // ROW-14 (parity-ledger.md), the user's 2026-09-13 decision to match
  // Todoist: a completed row's own checkbox click reaches this — not
  // `handleCompleteTask` again — through `TaskList`/`TaskTree`'s own
  // `onUncomplete` prop (task-tree.tsx's own doc comment on why it's a
  // second callback, not a branch inside `onComplete`). The task-shaped
  // signature matches every other TaskList/TaskTree callback on this page
  // (`handleCompleteTask` et al., just above) rather than the store's own
  // id-based `uncompleteTask` — this page is the one place that adapts
  // between the two shapes, not every caller several layers down.
  function handleUncompleteTask(task: Task) {
    uncompleteTask(task.id);
  }

  function handleOpenScheduleTask(task: Task) {
    handleOpenSchedule(task.id);
  }

  // Issue #178's Task detail view. `openTask` is looked up against
  // `tasks` **and** `completedTasks` — the identical two-list lookup
  // `entry-row.tsx`'s own Task Reference (`TaskReferenceItem`) already
  // uses to resolve a Task by id, for the identical reason: `tasks`
  // (TaskStore.list()) excludes completed rows by its own guarantee, so
  // a completed Task's own address would otherwise resolve to nothing
  // and silently fall back to Inbox instead of opening (the coordinator's
  // own gap-fix report against issue #184's activity feed — every
  // `completed` row links straight here). `tasks` first, since it's the
  // far more common case and a Task can never appear in both.
  const openTaskId = taskSlugId !== undefined ? taskIdFromParam(taskSlugId) : null;
  const openTask =
    openTaskId !== null
      ? (tasks.find((t) => t.id === openTaskId) ??
        completedTasks.find((t) => t.id === openTaskId) ??
        null)
      : null;
  const openTaskProject: Project | null =
    openTask === null ? null : (projects.find((p) => p.id === openTask.projectId) ?? null);
  // Issue #306: only meaningful while a Task's own detail route is
  // actually the active route (`openTask !== null` covers that, since
  // `hasCommentReplyIntent` reads whatever `?intent=` the *current* URL
  // carries regardless — a `?intent=reply` left over on some other route
  // would otherwise read as true there too).
  const openCommentComposer = openTask !== null && hasCommentReplyIntent(searchParams);

  // The open Task's own Section, for the breadcrumb — a *second*,
  // independent `listSections` query rather than reusing `sections`
  // above: `sections` is scoped to `currentProjectId` (the background
  // view's own Project), which disagrees with `openTask.projectId`
  // whenever a reader opens a Task from Today or from a different
  // Project's own list — a cross-view open is exactly the case
  // `backgroundView`'s own `location.state.from` fallback already has to
  // handle, and the breadcrumb needs the identical tolerance.
  const openTaskSectionsQuery = useQuery({
    queryKey: sectionsQueryKey(openTask?.projectId ?? ""),
    queryFn: () => listSections(openTask?.projectId as string),
    enabled: openTask !== null && openTask.projectId !== null,
  });
  const openTaskSection: Section | null =
    openTask === null || openTask.sectionId === null
      ? null
      : ((openTaskSectionsQuery.data ?? []).find((s) => s.id === openTask.sectionId) ?? null);

  // The open Task's own direct sub-tasks (issue #229) — `tasks`/
  // `completedTasks` are already the two flat, whole-account lists
  // `openTask` itself is resolved against just above, so narrowing them
  // client-side by `parentId` costs nothing beyond the array walk and
  // needs no third query the way `openTaskSectionsQuery` above does for a
  // Section scoped to a different Project than the background view's own.
  const openTaskSubtasks: Task[] =
    openTask === null
      ? []
      : [...tasks, ...completedTasks].filter((t) => t.parentId === openTask.id);

  // The list `prevTask`/`nextTask` step through — whichever list the
  // background view itself renders, in the identical order that view's
  // own rendering already puts its rows in, so stepping through the
  // detail view never disagrees with what a reader would see by closing
  // it and looking at the row order directly. Today's own order
  // (`today()`, @meologue/core) is recomputed here rather than reused
  // from a ref, on the same reasoning `TodayView` itself recomputes it on
  // every render: it's a pure function over `tasks` plus "now," cheap
  // enough that memoising it would cost more to reason about than it
  // saves. The Projects list has no Tasks of its own to page through.
  const backgroundTaskList: Task[] =
    backgroundView.view === "today"
      ? (() => {
          const { overdue, dueToday } = today(tasks, localDayKey(new Date()));
          return [...overdue, ...dueToday];
        })()
      : backgroundView.view === "upcoming"
        ? upcoming(tasks, localDayKey(new Date())).flatMap((day) => day.tasks)
        : backgroundView.view === "projects" ||
            backgroundView.view === "search" ||
            backgroundView.view === "activity" ||
            backgroundView.view === "filters" ||
            backgroundView.view === "filter" ||
            backgroundView.view === "labels"
          ? []
          : scopedTasks;
  const openTaskIndex =
    openTask === null ? -1 : backgroundTaskList.findIndex((t) => t.id === openTask.id);
  const prevTask = openTaskIndex > 0 ? (backgroundTaskList[openTaskIndex - 1] ?? null) : null;
  const nextTask =
    openTaskIndex >= 0 && openTaskIndex < backgroundTaskList.length - 1
      ? (backgroundTaskList[openTaskIndex + 1] ?? null)
      : null;

  // Opens a Task's own address (issue #178's own acceptance criterion:
  // "Clicking a Task should open it in a view of its own"). Carries the
  // *current* `backgroundView` as `location.state.from` — not
  // `useNavigate`'s `replace` — so the browser's own Back returns to
  // wherever this was opened from (this ticket's own acceptance
  // criterion), and TaskDetailView renders that same background dimmed
  // behind the modal/sheet while it's open.
  function openTaskDetail(task: Task) {
    navigate(taskDetailPath(task), { state: { from: backgroundView } });
  }

  // Steps to `prevTask`/`nextTask` without closing (TaskDetailView's own
  // `onNavigate`) — `replace: true`, unlike `openTaskDetail` above: this
  // is "look at a different Task while still standing in the same place,"
  // not a new navigation a reader would expect Back to unwind one step at
  // a time, so it doesn't grow the history stack per step the way opening
  // a fresh Task from a row does.
  function stepTaskDetail(task: Task) {
    navigate(taskDetailPath(task), { replace: true, state: { from: backgroundView } });
  }

  // Closes the detail view back onto whichever background it opened over
  // — a real navigation to `backgroundPath(backgroundView)`, not
  // `navigate(-1)`: `back-to-chats.tsx`'s own header comment gives the
  // identical reasoning for why a real link beats history navigation
  // here — a reader who opened this Task's address directly (a bookmark,
  // a shared link, a reload) has no in-app history entry to go back to,
  // and closing has to land somewhere sensible regardless.
  function closeTaskDetail() {
    navigate(backgroundPath(backgroundView));
  }

  // "Copy link to task" (the command menu's own item) — the same address
  // `openTaskDetail` navigates to, made absolute so it's meaningful
  // pasted anywhere outside this app. Wrapped rather than left to throw:
  // `navigator.clipboard` is unavailable over plain http and in some
  // embedded WebViews, and a silent failure here is better than an
  // unhandled rejection over a nice-to-have.
  // Quick-find's own "Show more results" (task-quick-find.tsx's header
  // comment) — hands the query to the full search page's own URL, a real
  // navigation (not `replace`) so Back from the search page returns to
  // wherever Quick-find was opened over, mirroring openTaskDetail's own
  // reasoning just below.
  function openFullSearch(query: string) {
    navigate(`/todo/search?q=${encodeURIComponent(query)}`);
  }

  function copyTaskLink(task: Task) {
    const url = `${window.location.origin}${taskDetailPath(task)}`;
    navigator.clipboard?.writeText(url).then(
      () => toast("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );
  }

  // Issue #228's keyboard layer — the one document-level listener for the
  // whole of Todo (`use-todo-keymap.ts`'s own header comment: "mounted
  // once by todo-page.tsx"), which this call site satisfies simply by
  // being inside this component's own body — `TodoPage` only ever renders
  // for `/todo/*` (App.tsx's routes), so this hook mounts and unmounts
  // with the route exactly the way `TodoNav`/the Todo sidebar already do.
  // `resolveTask` mirrors `openTask`'s own two-list lookup above (`tasks`
  // first, `completedTasks` as fallback — that lookup's own doc comment
  // has the reason a completed Task still needs to resolve).
  useTodoKeymap({
    resolveTask: (taskId) =>
      tasks.find((t) => t.id === taskId) ?? completedTasks.find((t) => t.id === taskId) ?? null,
    onOpenTaskDetail: openTaskDetail,
    onOpenSchedule: handleOpenSchedule,
    onSetTaskDate: setTaskDate,
    onSetTaskDeadline: setTaskDeadline,
    onRequestDelete: handleRequestDelete,
    // KBD-01: E completes the focused task, and Cmd/Ctrl+Shift+C copies its
    // link — both reuse the handlers the row's own controls already call.
    onCompleteTask: handleCompleteTask,
    onCopyLink: copyTaskLink,
    onOpenQuickFind: () => setQuickFindOpen(true),
    onShowShortcuts: () => setShortcutsOpen(true),
    onNavigate: navigate,
    // CMT-05 — the pending-undo ref's one door (`pendingUndoRef`'s own doc
    // comment above has the full reasoning). Nothing pending is this
    // callback's own no-op to make, not a `null` `use-todo-keymap.ts` has
    // to branch on.
    onUndoComplete: () => {
      pendingUndoRef.current?.undo();
    },
  });

  // Issue #247: both rename surfaces resolve a typed phrase through this
  // one wrapper — the row's `detailActions.onRename` below and the detail
  // view's own `onRename` prop (~:984) both call it, exactly the
  // composition `handleAdd` already does for the add field just below.
  // `commitTaskTitle` (task-title-commit.ts) carries the actual guards; this
  // function is only what binds it to this page's own Task lists and store
  // setters.
  const smartDates = useSettingsStore((state) => state.smartDatesEnabled);
  function commitRename(id: string, content: string) {
    const task = tasks.find((t) => t.id === id) ?? completedTasks.find((t) => t.id === id);
    if (task === undefined) {
      return;
    }
    void commitTaskTitle(
      task,
      content,
      { now: localDayKey(new Date()), smartDates },
      {
        renameTask,
        setTaskDate,
        setTaskDeadline,
        setTaskPriority,
        setTaskDateString,
        setTaskLabels,
        resolveLabelIds,
      },
    );
  }

  // Every row on this page renders through `TaskRow`, and every one of
  // them needs this identical bundle — see `TaskDetailActions`'s own doc
  // comment (task-row.tsx) for why it's threaded as one object rather
  // than five more props widening TaskList/TaskTree/TodayView/ProjectView.
  const detailActions: TaskDetailActions = {
    projects,
    labels,
    onOpenDetail: openTaskDetail,
    onSetPriority: setTaskPriority,
    // Issue #253: bundled here so every row's own per-instance
    // `TaskSchedulePopover` (task-row-content.tsx) reaches these without a
    // sixth prop threaded through TaskList/TaskTree/TodayView/ProjectView.
    onSetDate: setTaskDate,
    onSetDateString: setTaskDateString,
    datesWithTasks,
    onSetProject: setTaskProject,
    onSetLabels: setTaskLabels,
    onCopyLink: copyTaskLink,
    // Issue #225 built this door; issue #247 is what made it resolve a
    // recognised phrase rather than commit verbatim — see `commitRename`
    // just above, the identical door `TaskDetailView`'s own `onRename`
    // prop below already calls.
    onRename: commitRename,
    commentCountFor: (taskId) => commentCountForTask(comments, taskId),
  };

  // The add field's own parse (add-task-form.tsx, quick-add-task.ts)
  // resolves everything except `labelIds` — a `@label` name needs a
  // LabelStore round trip (use-labels.ts's `resolveLabelIds`) this
  // function is what awaits before a Task literal can be built at all.
  // `fields.date` overrides `captureDate` only when the reader actually
  // typed a date/time token or a recurrence resolved one (quick-add-
  // task.ts's own doc comment on why `??` — not the view's own inherited
  // date — is the fallback direction): what was typed always wins over
  // what the view merely suggested. `captureProjectId` has no equivalent
  // typed override — the add field parses dates and recurrence, not
  // `#project` tokens (CONTEXT.md names no such syntax), so a Project's
  // own inherited id is simply what every Task added from that view gets.
  async function handleAdd(fields: QuickAddTaskFields) {
    const labelIds = await resolveLabelIds(fields.labelNames);
    addTask(fields.content, {
      date: fields.date ?? captureDate,
      deadline: fields.deadline,
      priority: fields.priority,
      dateString: fields.dateString,
      labelIds,
      projectId: captureProjectId,
    });
  }

  async function handleAddSection(name: string): Promise<void> {
    if (currentProjectId === null) return;
    await addSection(currentProjectId, name);
  }

  // ProjectView's own delete confirmation needs the *true* number of
  // Tasks a Section's delete is about to destroy (issue #171's own
  // acceptance criterion: "names the count") — walked the identical way
  // ProjectStore.deleteSection's own doc comment describes its cascade
  // (direct members, then every descendant of each), so this can never
  // quietly under-count a Section holding sub-tasks.
  // The Activity view's own scope (issue #184): the view across
  // everything by default, or one Project's own history when opened with
  // a `?projectId=` query param (`project-view.tsx`'s own "Activity"
  // link) — filtered client-side from the one flat `events` list every
  // surface reads from, the identical "narrow the flat list, don't stand
  // up a second fetch" reasoning `comment-counts.ts`'s `commentsForTask`
  // already applies to Comments.
  const activityProjectId =
    backgroundView.view === "activity"
      ? new URLSearchParams(backgroundView.search ?? "").get("projectId")
      : null;
  const activityEvents =
    activityProjectId === null
      ? events
      : events.filter((event) => event.projectId === activityProjectId);

  async function countSectionDestruction(sectionId: string): Promise<number> {
    const direct = await listTasksInSection(sectionId);
    let total = direct.length;
    for (const task of direct) {
      const descendants = await listTaskDescendants(task.id);
      total += descendants.length;
    }
    return total;
  }

  return (
    <Shell
      title={todoHeading(backgroundView, currentProject, currentFilter)}
      back={<BackToChats />}
      message={message}
      messageAction={messageAction}
      // Issue #307: the minimal door — nothing on a narrow viewport linked
      // to the real `/todo/search` route or page before this (the bottom
      // bar's six destinations, todo-nav-destinations.ts, don't include it,
      // and TodoSidebar only renders at the wide breakpoint `wide` names
      // below). `undefined`, not `false`/`null`, when hidden: Shell's own
      // `{action && ...}` check (shell.tsx) treats any of the three
      // identically, and `undefined` is what every other page already
      // passes for "no action" here.
      //
      // A real `<Link>` (below), not a `navigate()` call from a plain
      // button — a real push navigation, the same shape `openFullSearch`
      // already uses for Quick-find's "Show more results" — is what makes
      // "reaching Search and going back returns the reader where they
      // were" true: `use-back-button.ts`'s depth counter and
      // `back-button.android.ts`'s `window.history.back()` both key off a
      // real history entry existing, which only a push (not a `replace`)
      // leaves behind.
      action={
        !wide && backgroundView.view !== "search" ? (
          <Link
            to="/todo/search"
            aria-label="Search"
            // size-12 (48 CSS px) — the acceptance criterion's own floor,
            // one Tailwind step above every other app-bar icon control in
            // this app (back-to-chats.tsx's own size-11/44px comment).
            className="flex size-12 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Search aria-hidden="true" className="size-5" />
          </Link>
        ) : undefined
      }
      composerSlot={<TodoNav />}
      floatingAction={<TodoCreateFab />}
      // Issue #254: Todo reads like Todoist's own page now — an 800px
      // column above the existing 900px wide-layout breakpoint (reused
      // rather than inventing a second one; see `use-wide-layout.ts`'s
      // `WIDE_LAYOUT_QUERY`), staying proportional below it exactly like
      // every other Destination, and its own in-column heading in place of
      // the app bar (ADR 0019's amendment has both, and the accepted
      // scrolling-Back consequence).
      columnWidthClassName="w-[97%] md:w-[85%] min-[900px]:w-full min-[900px]:max-w-[800px]"
      hideAppBar
    >
      {backgroundView.view === "today" && (
        <TodayView
          tasks={tasks}
          detailActions={detailActions}
          onComplete={handleComplete}
          onCompleteForever={handleCompleteForever}
          onRequestDelete={handleRequestDelete}
          onOpenSchedule={handleOpenSchedule}
          onSetDate={setTaskDate}
        />
      )}

      {backgroundView.view === "upcoming" && (
        <UpcomingView
          tasks={tasks}
          detailActions={detailActions}
          onComplete={handleComplete}
          onCompleteForever={handleCompleteForever}
          onRequestDelete={handleRequestDelete}
          onOpenSchedule={handleOpenSchedule}
          onSetDate={setTaskDate}
        />
      )}

      {backgroundView.view === "inbox" && (
        <TaskList
          tasks={scopedTasks}
          completedTasks={completedTasks}
          onUncomplete={handleUncompleteTask}
          sections={[]}
          projectId={null}
          emptyMessage="Nothing in your Inbox. Add a Task above to get started."
          detailActions={detailActions}
          onComplete={handleCompleteTask}
          onCompleteForever={handleCompleteForeverTask}
          onRequestDelete={handleRequestDeleteTask}
          onOpenSchedule={handleOpenScheduleTask}
          reorderTask={reorderTask}
          setTaskParent={setTaskParent}
          listTaskChildren={listTaskChildren}
          countTaskChildren={countTaskChildren}
          listTasksInProject={listTasksInProject}
        />
      )}

      {backgroundView.view === "project" &&
        (currentProject === null ? (
          // Loading (`projects` hasn't resolved yet) or a bad/removed id —
          // this component has no way to tell those apart, and neither is
          // worth a special-cased message: both read as "there is nothing
          // here yet" until `projects` catches up or a reader navigates
          // away, the identical posture `entry-store-layout.tsx`'s own
          // `disabled` branch takes for "the store hasn't opened yet."
          <p className="px-3 py-6 text-center text-muted-foreground text-sm">Loading…</p>
        ) : (
          <ProjectView
            project={currentProject}
            sections={sections}
            tasks={scopedTasks}
            completedTasks={completedTasks}
            onUncomplete={handleUncompleteTask}
            detailActions={detailActions}
            onRename={(name) => renameProject(currentProject.id, name)}
            onSetColour={(colour) => setProjectColour(currentProject.id, colour)}
            onSetDescription={(description) =>
              setProjectDescription(currentProject.id, description)
            }
            projects={projects}
            onSetParent={(parentId) => setProjectParent(currentProject.id, parentId)}
            onToggleFavourite={(favourite) => setProjectFavourite(currentProject.id, favourite)}
            onToggleArchived={(archived) =>
              archived ? archiveProject(currentProject.id) : unarchiveProject(currentProject.id)
            }
            onDeleteProject={() => {
              removeProject(currentProject.id);
              navigate("/todo/projects");
            }}
            onAddSection={handleAddSection}
            onRenameSection={renameSection}
            onReorderSection={reorderSection}
            onArchiveSection={archiveSection}
            onUnarchiveSection={unarchiveSection}
            onDeleteSection={deleteSection}
            countSectionDestruction={countSectionDestruction}
            onComplete={handleCompleteTask}
            onCompleteForever={handleCompleteForeverTask}
            onRequestDelete={handleRequestDeleteTask}
            onOpenSchedule={handleOpenScheduleTask}
            onMoveToSection={setTaskSection}
            reorderTask={reorderTask}
            setTaskParent={setTaskParent}
            listTaskChildren={listTaskChildren}
            countTaskChildren={countTaskChildren}
            listTasksInProject={listTasksInProject}
          />
        ))}

      {backgroundView.view === "projects" && (
        <ProjectsView
          projects={projects}
          onAdd={(name, colour, parentId) => addProject(name, { colour, parentId })}
          onToggleFavourite={setProjectFavourite}
          onToggleArchived={(id, archived) =>
            archived ? archiveProject(id) : unarchiveProject(id)
          }
        />
      )}

      {backgroundView.view === "filters" && <FiltersView filters={filters} labels={labels} />}

      {/* Issue #229's own gap: a real destination for the sidebar's
          "Filters & Labels" row (ledger row NAV-06) — full Label
          create/rename/recolour/delete, previously wired to no UI at
          all. */}
      {backgroundView.view === "labels" && (
        <LabelsView
          labels={labels}
          onAdd={addLabel}
          onRename={renameLabel}
          onSetColour={setLabelColour}
          onRemove={removeLabel}
        />
      )}

      {backgroundView.view === "filter" &&
        (!currentFilter && currentFilterId !== null ? (
          // Loading (`filters` hasn't resolved yet) or a bad/removed id —
          // mirrors ProjectView's own identical "can't tell those apart,
          // neither is worth a special-cased message" posture just above.
          <p className="px-3 py-6 text-center text-muted-foreground text-sm">Loading…</p>
        ) : (
          <FilterView
            filter={currentFilter}
            tasks={tasks}
            projects={projects}
            labels={labels}
            listSections={listSections}
            onCreate={(name, query, colour) => addFilter(name, query, { colour })}
            onRename={(name) => currentFilter && renameFilter(currentFilter.id, name)}
            onSetColour={(colour) => currentFilter && setFilterColour(currentFilter.id, colour)}
            onSetQuery={(query) =>
              currentFilter ? setFilterQuery(currentFilter.id, query) : Promise.resolve()
            }
            onRemove={() => currentFilter && removeFilter(currentFilter.id)}
            onOpenTask={openTaskDetail}
          />
        ))}

      {backgroundView.view === "search" && (
        <TaskSearchPage
          tasks={tasks}
          completedTasks={completedTasks}
          comments={comments}
          projects={projects}
          onOpenTask={openTaskDetail}
          onUncompleteTask={uncompleteTask}
        />
      )}

      {/* Issue #184: the view across everything, or one Project's own
          history when opened with `?projectId=`. CMT-07: no "Completed
          only" toggle, by the user's decision on 2026-09-13 to match
          Todoist, which has none. */}
      {backgroundView.view === "activity" && (
        <div className="flex flex-col gap-2">
          <ActivityFeed
            events={activityEvents}
            // Both active and completed — a `completed` Event's own Task
            // lives in `completedTasks`, not `tasks`, and the feed needs
            // to resolve either to name its subject live.
            tasks={[...tasks, ...completedTasks]}
            projects={projects}
            emptyMessage={
              activityProjectId !== null
                ? "Nothing has happened in this Project yet."
                : "Nothing has happened yet."
            }
          />
        </div>
      )}

      {/* Issue #252: moved here, from before the view switch above, so it
          renders *after* whichever list is showing rather than above every
          one of them — Todoist's own "+ Add task" affordance sits at the
          end of the list (NAV-10, parity ledger), not above it. Inbox,
          Today and a Project's own view are mutually exclusive branches
          (only one of the blocks above ever actually renders something),
          so one render, placed once here, lands after the list in all
          three with no per-view duplication — the identical trick this
          file's own header comment already relies on for `AddTaskForm`
          being "shared... once." Guard condition is unchanged from
          before the move: the Projects list, full search, Activity,
          Filters, a saved Filter, Labels and Upcoming still get none (this
          component's own next paragraph explains why each one specifically
          has no "current view" for a captured Task to inherit). */}
      {backgroundView.view !== "projects" &&
        backgroundView.view !== "search" &&
        backgroundView.view !== "activity" &&
        backgroundView.view !== "filters" &&
        backgroundView.view !== "filter" &&
        backgroundView.view !== "labels" &&
        backgroundView.view !== "upcoming" && (
          <AddTaskForm
            onAdd={handleAdd}
            disabled={disabled}
            projects={projects}
            labels={labels}
            onCreateProject={addProject}
            onCreateLabel={addLabel}
          />
        )}

      {/* NAV-07 (parity ledger): the global Quick Add dialog, reachable
          from anywhere in Todo — the sidebar's "Add task" button and the
          `Q` key both open it (this file's own `quickAddOpen` state doc
          comment above). Shares `handleAdd` verbatim with the inline
          composer above: `captureProjectId`/`captureDate`'s own doc
          comment already resolves "the current view's Project, or Inbox"
          for whichever view is on screen, exactly what this dialog needs
          too, and there is no separate view-inheritance rule for it to
          duplicate. */}
      <QuickAddDialog
        open={quickAddOpen}
        onOpenChange={setQuickAddOpen}
        onAdd={handleAdd}
        projects={projects}
        labels={labels}
        onCreateProject={addProject}
        onCreateLabel={addLabel}
      />

      {schedulingTask !== null && (
        // `LazyTaskScheduleSheet`'s own header comment: this and
        // `TaskDetailView` below are the two things that moved Todo's
        // route off its 651-byte headroom (issue #228/#229's own brief).
        // `fallback={null}` matches `lazy-destructive-confirm-dialog.ts`'s
        // callers — a Sheet opening from a deliberate tap tolerates one
        // frame with nothing rendered far better than a route's first
        // paint would.
        <Suspense fallback={null}>
          <LazyTaskScheduleSheet
            task={schedulingTask}
            open={true}
            onOpenChange={(open) => {
              if (!open) {
                setSchedulingId(null);
              }
            }}
            onSetDeadline={setTaskDeadline}
            onSetPriority={setTaskPriority}
          />
        </Suspense>
      )}

      <ConfirmDialog
        open={confirmingTask !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingId(null);
          }
        }}
        /*
         * Todoist's own captured wording (quick-add.md § "Destructive
         * confirmation wording"), matching the Project and Label dialogs
         * this branch already aligned.
         *
         * It is worth being clear about what that costs, because the copy
         * this replaces was not worse by accident. It said the row "stays
         * gone on every Device, and there is no Undo (unlike completing,
         * which you can always reverse)" — two things Todoist never has to
         * say and this app arguably does: that deletion propagates through
         * Sync, and that it is the one destructive act here with no undo,
         * where completion always has one. Parity was the instruction, so
         * parity wins; the loss is recorded in the ledger rather than
         * quietly absorbed, so it can be reversed on purpose if the
         * clearer copy turns out to matter more than the match.
         */
        title="Delete task?"
        // ROW-06 (parity-ledger.md): Todoist's own delete-confirmation
        // dialog also renders a title's markdown — flow 10's decisive test
        // quoted it as "The ZZ probe bold em code task will be permanently
        // deleted." for a title verified to hold only literal `**bold**
        // _em_ `code`` characters (`live-audit-dom/flow10-ROW-06-both.
        // json`), where meologue's own dialog used to quote the raw
        // markdown verbatim. Only the interpolated name gets `inlineProse`
        // — the surrounding sentence ("The … task will be permanently
        // deleted.") is this app's own copy, not part of the Task's title.
        description={
          confirmingTask && (
            <>The {inlineProse(confirmingTask.content)} task will be permanently deleted.</>
          )
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmingTask) {
            removeTask(confirmingTask.id);
          }
        }}
      />

      {/* Issue #178's Task detail view — a route AND a modal/sheet at
          once (task-detail-view.tsx's own header comment). Rendered
          alongside whichever background view above is currently on
          screen, not instead of it: `openTask` is only non-null while
          `/todo/task/:taskSlugId` is the active route, and the
          background view underneath is exactly what `backgroundView`
          already computed for every other branch above. */}
      {openTask !== null && (
        // `LazyTaskDetailView`'s own header comment has the bundle numbers.
        // `fallback={null}` for the same reason `LazyTaskScheduleSheet`'s
        // own call site above gives: opening a Task is a deliberate
        // navigation, not a route's first paint, so one frame with nothing
        // rendered over the (still-visible) background view is the right
        // trade, not a visible regression.
        <Suspense fallback={null}>
          <LazyTaskDetailView
            task={openTask}
            project={openTaskProject}
            section={openTaskSection}
            projects={projects}
            labels={labels}
            prevTask={prevTask}
            nextTask={nextTask}
            onClose={closeTaskDetail}
            onNavigate={stepTaskDetail}
            onRename={(content) => commitRename(openTask.id, content)}
            // Issue #184's own gap-fix report: the detail view now resolves
            // (and must render actionable) a completed Task too — reuses
            // `handleComplete`'s own recurring-Task/toast handling, the
            // identical door every other completion entry point already
            // goes through, rather than this view's own checkbox
            // duplicating that logic.
            onComplete={() => handleComplete(openTask.id, openTask.content, openTask.dateString)}
            onUncomplete={() => uncompleteTask(openTask.id)}
            // Issue #302: the detail view's own overflow menu reuses the
            // identical handlers the row's own `TaskCommandMenu`/dedicated
            // button already call — `copyTaskLink`, `removeTask` and
            // `handleCompleteForeverTask` (this file's own "adapts to the
            // task-shaped callback" trio, just above) — rather than this
            // page growing a second copy of any of the three.
            onCopyLink={() => copyTaskLink(openTask)}
            onDelete={() => removeTask(openTask.id)}
            onCompleteForever={() => handleCompleteForeverTask(openTask)}
            onOpenSchedule={() => handleOpenSchedule(openTask.id)}
            onSetDate={setTaskDate}
            onSetDateString={setTaskDateString}
            datesWithTasks={datesWithTasks}
            onSetProject={(projectId) => setTaskProject(openTask.id, projectId)}
            onSetLabels={(labelIds) => setTaskLabels(openTask.id, labelIds)}
            onSetDescription={(description) => setTaskDescription(openTask.id, description)}
            comments={commentsForTask(comments, openTask.id)}
            onAddComment={(text) => addComment(openTask.id, text)}
            onEditComment={editComment}
            onRemoveComment={removeComment}
            openCommentComposer={openCommentComposer}
            subtasks={openTaskSubtasks}
            onAddSubtask={(content) => addTask(content, { parentId: openTask.id })}
            onCompleteSubtask={(id) => {
              const subtask = openTaskSubtasks.find((t) => t.id === id);
              if (subtask) {
                handleComplete(subtask.id, subtask.content, subtask.dateString);
              }
            }}
            onUncompleteSubtask={(id) => uncompleteTask(id)}
            // Issue #184: this Task's own history, newest first — narrowed
            // client-side from the one flat `events` list, mirroring
            // `commentsForTask`'s identical narrowing just above.
            events={events.filter((event) => event.taskId === openTask.id)}
          />
        </Suspense>
      )}

      {/* Quick-find (issue #183) — mounted unconditionally, once, regardless
          of which view above is on screen, so `/`/`f`/⌘K open it from
          anywhere in Todo, the same "narrows Tasks, never reaches into
          Entries or Sessions" scope every other Todo view already keeps
          (task-quick-find.tsx's own header comment). `tasks` is the flat,
          cross-Project array this component already leans on for
          `confirmingTask`/`schedulingTask`/`openTask` above. */}
      <TaskQuickFind
        open={quickFindOpen}
        onOpenChange={setQuickFindOpen}
        tasks={tasks}
        projects={projects}
        onOpenTask={openTaskDetail}
        onOpenProject={(projectId) =>
          navigate(projectId === null ? "/todo/inbox" : `/todo/projects/${projectId}`)
        }
        onShowMoreResults={openFullSearch}
      />

      {/* Issue #228's `?` overlay — `open`/`onOpenChange` mirror Quick-
          find's own just above, toggled by the identical keyboard layer
          (`useTodoKeymap`'s `onShowShortcuts`). */}
      <TodoKeyboardShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </Shell>
  );
}
