import type { Task } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { BackToChats } from "@/components/back-to-chats";
import { localDayKey } from "@/components/date-picker-sheet";
import { Shell } from "@/components/shell";
import { AddTaskForm } from "@/components/todo/add-task-form";
import { CompletedTasks } from "@/components/todo/completed-tasks";
import { ProjectView } from "@/components/todo/project-view";
import { ProjectsView } from "@/components/todo/projects-view";
import { TaskList } from "@/components/todo/task-list";
import { TaskScheduleSheet } from "@/components/todo/task-schedule-sheet";
import { TodayView } from "@/components/todo/today-view";
import { TodoNav } from "@/components/todo/todo-nav";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { sectionsQueryKey, tasksInProjectQueryKey } from "@/lib/query-keys";
import type { QuickAddTaskFields } from "@/lib/quick-add-task";
import { useEntryStore } from "@/pages/entry-store-layout";

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
  view?: "inbox" | "today" | "projects" | "project";
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
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const currentProjectId = view === "project" ? (routeProjectId ?? null) : null;

  const {
    tasks,
    completedTasks,
    addTask,
    completeTask,
    uncompleteTask,
    reorderTask,
    removeTask,
    disabled,
    message,
    setTaskDate,
    setTaskDeadline,
    setTaskDuration,
    setTaskPriority,
    listTasksInProject,
    listTaskChildren,
    listTasksInSection,
    listTaskDescendants,
    advanceRecurringTask,
    completeForeverTask,
    postponeTask,
    setTaskParent,
    setTaskSection,
    resolveLabelIds,
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
  const captureDate = view === "today" ? localDayKey(new Date()) : null;
  const captureProjectId = view === "project" ? currentProjectId : null;

  // Inbox's and a Project's own top-level Tasks (TaskStore.listByProject,
  // `null` meaning Inbox) — this component's own header comment on why
  // this replaced the flat `tasks` array for these two views specifically.
  // `enabled` skips the fetch entirely for Today/Projects, which have no
  // use for it.
  const scopeProjectId = view === "inbox" ? null : currentProjectId;
  const scopedTasksQuery = useQuery({
    queryKey: tasksInProjectQueryKey(scopeProjectId),
    queryFn: () => listTasksInProject(scopeProjectId),
    enabled: view === "inbox" || (view === "project" && currentProjectId !== null),
  });
  const scopedTasks = scopedTasksQuery.data ?? [];

  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;

  const sectionsQuery = useQuery({
    queryKey: sectionsQueryKey(currentProjectId ?? ""),
    queryFn: () => listSections(currentProjectId as string),
    enabled: view === "project" && currentProjectId !== null,
  });
  const sections = sectionsQuery.data ?? [];

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmingTask = tasks.find((task) => task.id === confirmingId) ?? null;

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
      duration: fields.duration,
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
      {/* Shared by Inbox, Today and a Project's own view — only the
          Projects list (`view === "projects"`) has nothing to add a Task
          to, and gets its own "New Project" form instead
          (`ProjectsView`). */}
      {view !== "projects" && <AddTaskForm onAdd={handleAdd} disabled={disabled} />}

      {view === "today" && (
        <TodayView
          tasks={tasks}
          onComplete={handleComplete}
          onCompleteForever={handleCompleteForever}
          onRequestDelete={handleRequestDelete}
          onOpenSchedule={handleOpenSchedule}
          onSetDate={setTaskDate}
          onPostpone={postponeTask}
        />
      )}

      {view === "inbox" && (
        <TaskList
          tasks={scopedTasks}
          sections={[]}
          projectId={null}
          emptyMessage="Nothing in your Inbox. Add a Task above to get started."
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

      {view === "project" &&
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

      {view === "projects" && (
        <ProjectsView
          projects={projects}
          onAdd={(name, colour) => addProject(name, { colour })}
          onToggleFavourite={setProjectFavourite}
          onToggleArchived={(id, archived) =>
            archived ? archiveProject(id) : unarchiveProject(id)
          }
        />
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
      {view === "inbox" && <CompletedTasks tasks={completedTasks} onUncomplete={uncompleteTask} />}

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
          onSetDuration={setTaskDuration}
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
    </Shell>
  );
}
