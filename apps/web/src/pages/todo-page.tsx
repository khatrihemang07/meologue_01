import type { Project, Section, Task } from "@meologue/core";
import { today } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { localDayKey } from "@/components/date-picker-sheet";
import { Shell } from "@/components/shell";
import { ActivityFeed } from "@/components/todo/activity-feed";
import { AddTaskForm } from "@/components/todo/add-task-form";
import { CompletedTasks } from "@/components/todo/completed-tasks";
import { FilterView } from "@/components/todo/filter-view";
import { FiltersView } from "@/components/todo/filters-view";
import { ProjectView } from "@/components/todo/project-view";
import { ProjectsView } from "@/components/todo/projects-view";
import { TaskDetailView } from "@/components/todo/task-detail-view";
import { TaskList } from "@/components/todo/task-list";
import { TaskQuickFind } from "@/components/todo/task-quick-find";
import type { TaskDetailActions } from "@/components/todo/task-row";
import { TaskScheduleSheet } from "@/components/todo/task-schedule-sheet";
import { TaskSearchPage } from "@/components/todo/task-search-page";
import { TodayView } from "@/components/todo/today-view";
import { TodoNav } from "@/components/todo/todo-nav";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { commentCountForTask, commentsForTask } from "@/lib/comment-counts";
import { sectionsQueryKey, tasksInProjectQueryKey } from "@/lib/query-keys";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { taskDetailPath, taskIdFromParam } from "@/lib/task-detail-route";
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
  view: "inbox" | "today" | "projects" | "project" | "search" | "activity" | "filters" | "filter";
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
  view?: "inbox" | "today" | "projects" | "project" | "search" | "activity" | "filters" | "filter";
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
 *
 * The Add form, the Completed disclosure, the delete confirmation, and the
 * schedule sheet are all owned here, once, and shared by every view that
 * needs them rather than each growing its own copy — deleting or
 * scheduling a Task is the identical act regardless of which view's row a
 * reader tapped it from, and `confirmingTask`/`schedulingTask` below are
 * looked up against the flat `tasks` array precisely because that array
 * still holds every Task anywhere (its own doc comment, above), so one
 * lookup works for a row from any view without this component needing to
 * know which scope it came from.
 *
 * The Add form is shared too, but it is **not** context-free — see
 * `captureDate`/`captureProjectId` below.
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
    setTaskDate,
    setTaskDeadline,
    setTaskPriority,
    setTaskLabels,
    listTasksInProject,
    listTaskChildren,
    listTasksInSection,
    listTaskDescendants,
    advanceRecurringTask,
    completeForeverTask,
    postponeTask,
    setTaskProject,
    setTaskParent,
    setTaskSection,
    setTaskDescription,
    labels,
    resolveLabelIds,
    comments,
    addComment,
    editComment,
    removeComment,
    projects,
    addProject,
    renameProject,
    setProjectDescription,
    setProjectFavourite,
    archiveProject,
    unarchiveProject,
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

  // Issue #184: "completed work is reached by narrowing the log to
  // completions, not from a separate destination of its own" — a plain
  // toggle above the Activity view rather than a second route.
  const [activityCompletedOnly, setActivityCompletedOnly] = useState(false);

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
  function handleComplete(taskId: string, content: string, dateString: string | null) {
    if (dateString !== null) {
      advanceRecurringTask(taskId);
      return;
    }
    completeTask(taskId);
    toast(`Completed "${content}"`, {
      action: {
        label: "Undo",
        onClick: () => uncompleteTask(taskId),
      },
    });
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
  function handleCompleteForever(taskId: string, content: string) {
    completeForeverTask(taskId);
    toast(`Completed "${content}" — the recurrence has ended`, {
      action: {
        label: "Undo",
        onClick: () => uncompleteTask(taskId),
      },
    });
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
      : backgroundView.view === "projects" ||
          backgroundView.view === "search" ||
          backgroundView.view === "activity" ||
          backgroundView.view === "filters" ||
          backgroundView.view === "filter"
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

  // Every row on this page renders through `TaskRow`, and every one of
  // them needs this identical bundle — see `TaskDetailActions`'s own doc
  // comment (task-row.tsx) for why it's threaded as one object rather
  // than five more props widening TaskList/TaskTree/TodayView/ProjectView.
  const detailActions: TaskDetailActions = {
    projects,
    labels,
    onOpenDetail: openTaskDetail,
    onSetPriority: setTaskPriority,
    onSetProject: setTaskProject,
    onSetLabels: setTaskLabels,
    onCopyLink: copyTaskLink,
    commentCountFor: (taskId) => commentCountForTask(comments, taskId),
  };

  // The add field's own parse (add-task-form.tsx, quick-add-task.ts)
  // resolves everything except `labelIds` — a `%label` name needs a
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
    <Shell title="Todo" back={<BackToChats />} message={message} composerSlot={<TodoNav />}>
      {/* Shared by Inbox, Today and a Project's own view — the Projects
          list (`view === "projects"`) has nothing to add a Task to, and
          gets its own "New Project" form instead (`ProjectsView`); the
          full search page (`view === "search"`, issue #183) is a results
          list with no "current view" for a captured Task to inherit
          either, the identical reasoning. */}
      {backgroundView.view !== "projects" &&
        backgroundView.view !== "search" &&
        backgroundView.view !== "activity" &&
        backgroundView.view !== "filters" &&
        backgroundView.view !== "filter" && <AddTaskForm onAdd={handleAdd} disabled={disabled} />}

      {backgroundView.view === "today" && (
        <TodayView
          tasks={tasks}
          detailActions={detailActions}
          onComplete={handleComplete}
          onCompleteForever={handleCompleteForever}
          onRequestDelete={handleRequestDelete}
          onOpenSchedule={handleOpenSchedule}
          onSetDate={setTaskDate}
          onPostpone={postponeTask}
        />
      )}

      {backgroundView.view === "inbox" && (
        <TaskList
          tasks={scopedTasks}
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
            detailActions={detailActions}
            onRename={(name) => renameProject(currentProject.id, name)}
            onSetDescription={(description) =>
              setProjectDescription(currentProject.id, description)
            }
            onToggleFavourite={(favourite) => setProjectFavourite(currentProject.id, favourite)}
            onToggleArchived={(archived) =>
              archived ? archiveProject(currentProject.id) : unarchiveProject(currentProject.id)
            }
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
            listTasksInProject={listTasksInProject}
          />
        ))}

      {backgroundView.view === "projects" && (
        <ProjectsView
          projects={projects}
          onAdd={(name, colour) => addProject(name, { colour })}
          onToggleFavourite={setProjectFavourite}
          onToggleArchived={(id, archived) =>
            archived ? archiveProject(id) : unarchiveProject(id)
          }
        />
      )}

      {backgroundView.view === "filters" && <FiltersView filters={filters} />}

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
          history when opened with `?projectId=` — never a second
          destination for completed work alone (this component's own
          `activityCompletedOnly` toggle narrows the same log instead). */}
      {backgroundView.view === "activity" && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 px-3 py-1 text-muted-foreground text-sm">
            <input
              type="checkbox"
              checked={activityCompletedOnly}
              onChange={(event) => setActivityCompletedOnly(event.target.checked)}
            />
            Completed only
          </label>
          <ActivityFeed
            events={activityEvents}
            // Both active and completed — a `completed` Event's own Task
            // lives in `completedTasks`, not `tasks`, and the feed needs
            // to resolve either to name its subject live.
            tasks={[...tasks, ...completedTasks]}
            projects={projects}
            completedOnly={activityCompletedOnly}
            emptyMessage={
              activityProjectId !== null
                ? "Nothing has happened in this Project yet."
                : "Nothing has happened yet."
            }
          />
        </div>
      )}

      {/* The Completed disclosure is Inbox-specific — Today's own Tasks
          are never completed *from* Today in a way that would need a
          second copy of this list; completing a Task from either view
          moves it into the identical shared `completedTasks`, and this is
          Todo's one door onto it, the same reasoning `handleComplete`'s
          own doc comment gives for the schedule sheet being shared rather
          than per-view. A Project's own view has no Completed disclosure
          of its own — out of this ticket's scope, named in its report
          rather than built ahead of being asked for. */}
      {backgroundView.view === "inbox" && (
        <CompletedTasks tasks={completedTasks} onUncomplete={uncompleteTask} />
      )}

      {schedulingTask !== null && (
        <TaskScheduleSheet
          task={schedulingTask}
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setSchedulingId(null);
            }
          }}
          onSetDate={setTaskDate}
          onSetDeadline={setTaskDeadline}
          onSetPriority={setTaskPriority}
        />
      )}

      <ConfirmDialog
        open={confirmingTask !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmingId(null);
          }
        }}
        title="Delete this Task?"
        description={
          confirmingTask && (
            <>
              Deleting "{confirmingTask.content}" is permanent — the row stays gone on every Device,
              and there is no Undo (unlike completing, which you can always reverse).
            </>
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
        <TaskDetailView
          task={openTask}
          project={openTaskProject}
          section={openTaskSection}
          projects={projects}
          labels={labels}
          prevTask={prevTask}
          nextTask={nextTask}
          onClose={closeTaskDetail}
          onNavigate={stepTaskDetail}
          onRename={(content) => renameTask(openTask.id, content)}
          // Issue #184's own gap-fix report: the detail view now resolves
          // (and must render actionable) a completed Task too — reuses
          // `handleComplete`'s own recurring-Task/toast handling, the
          // identical door every other completion entry point already
          // goes through, rather than this view's own checkbox
          // duplicating that logic.
          onComplete={() => handleComplete(openTask.id, openTask.content, openTask.dateString)}
          onUncomplete={() => uncompleteTask(openTask.id)}
          onOpenSchedule={() => handleOpenSchedule(openTask.id)}
          onSetProject={(projectId) => setTaskProject(openTask.id, projectId)}
          onSetLabels={(labelIds) => setTaskLabels(openTask.id, labelIds)}
          onSetDescription={(description) => setTaskDescription(openTask.id, description)}
          comments={commentsForTask(comments, openTask.id)}
          onAddComment={(text) => addComment(openTask.id, text)}
          onEditComment={editComment}
          onRemoveComment={removeComment}
          // Issue #184: this Task's own history, newest first — narrowed
          // client-side from the one flat `events` list, mirroring
          // `commentsForTask`'s identical narrowing just above.
          events={events.filter((event) => event.taskId === openTask.id)}
        />
      )}

      {/* Quick-find (issue #183) — mounted unconditionally, once, regardless
          of which view above is on screen, so `/`/`f`/⌘K open it from
          anywhere in Todo, the same "narrows Tasks, never reaches into
          Entries or Sessions" scope every other Todo view already keeps
          (task-quick-find.tsx's own header comment). `tasks` is the flat,
          cross-Project array this component already leans on for
          `confirmingTask`/`schedulingTask`/`openTask` above. */}
      <TaskQuickFind
        tasks={tasks}
        projects={projects}
        onOpenTask={openTaskDetail}
        onOpenProject={(projectId) =>
          navigate(projectId === null ? "/todo/inbox" : `/todo/projects/${projectId}`)
        }
        onShowMoreResults={openFullSearch}
      />
    </Shell>
  );
}
