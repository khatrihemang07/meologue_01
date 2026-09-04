import type {
  CommentStore,
  EntryStore,
  EventStore,
  LabelStore,
  ProjectStore,
  Task,
  TaskStore,
} from "@meologue/core";
import { mintId, orderKeyBetween } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type RecordEventInput, useEvents } from "@/hooks/use-events";
import { queryClient } from "@/lib/query-client";
import { COMPLETED_TASKS_QUERY_KEY, ENTRIES_QUERY_KEY, TASKS_QUERY_KEY } from "@/lib/query-keys";
import { requestSync } from "@/lib/sync-runner";
import { syncTaskReferenceChecked, syncTaskReferenceLabel } from "@/lib/task-reference-sync";
import { refreshTasks } from "@/lib/tasks-refresh";

/**
 * Everything about a new Task beyond its `content` that a caller might
 * already know — the view's own inherited `date` (todo-page.tsx's
 * `captureDate`), and, since issue #170, whatever quick-add-task.ts's
 * `taskFieldsFromQuickAdd` resolved out of what the reader actually typed
 * (add-task-form.tsx). A plain options object rather than five positional
 * parameters: every field here is independently optional (a caller with
 * nothing more to say than "add this text" — every pre-#170 call site,
 * and this file's own tests — passes none of them), which a positional
 * signature has no way to express past the first optional parameter
 * without every caller learning the full parameter order to skip earlier
 * ones with `undefined`.
 */
export interface AddTaskOverrides {
  /** The Task's `date` — the view's own inherited date if the reader typed no date/time token of their own, or `taskFieldsFromQuickAdd`'s resolved `date` (an explicit token, or a recognised recurrence's first occurrence) if they did. Undated (`null`) by default, matching a Task created directly in Todo (issue #169's own acceptance criterion). */
  date?: string | null;
  deadline?: string | null;
  priority?: number;
  labelIds?: string[];
  /** `Task.dateString` — the canonical recurrence phrase quick-add-task.ts resolved, or `null` for a Task that doesn't repeat. */
  dateString?: string | null;
  /**
   * The Project a new Task is filed into (issue #171) — `null` for Inbox.
   * The identical "default is inherited from origin" rule `date` above
   * already carries (todo-page.tsx's `captureDate`), applied to structure
   * rather than schedule: a Task added while standing in a Project's own
   * view inherits that Project, exactly as one added from Today inherits
   * today's date and one added from Inbox inherits nothing. `null` by
   * default, matching a Task created directly in Todo with no Project
   * context at all (issue #169's own "starts undated" precedent, applied
   * here to "starts unfiled").
   */
  projectId?: string | null;
  /**
   * The Section a new Task is filed into within `projectId` (issue #171)
   * — `null` for "no Section," the state every Task in Inbox is
   * structurally stuck at (Section.projectId is required, never Inbox —
   * ../../packages/core/src/project-types.ts's own doc comment). Set only
   * when the reader added the Task from inside a specific Section's own
   * add affordance; a Project's own top-level add field leaves this
   * `null` the same way it leaves `parentId` below `null`.
   */
  sectionId?: string | null;
}

export interface UseTasksResult {
  /** Active Tasks, in (orderKey, id) order — TaskStore.list()'s own guarantee (ADR 0050). */
  tasks: Task[];
  /** Completed Tasks, newest completion first — TaskStore.listCompleted(). */
  completedTasks: Task[];
  /**
   * Creates a Task from plain text, appended to the end of the active
   * list. Ignores blank input, mirroring sendEntry. `overrides` is the
   * *view's* own context plus, since issue #170, whatever the reader's
   * own typed line resolved to — see `addTask`'s implementation for why
   * every field defaults to the same "nothing" a Task created directly in
   * Todo starts with, rather than this hook assuming a caller always has
   * an opinion.
   */
  addTask: (content: string, overrides?: AddTaskOverrides) => void;
  completeTask: (id: string) => void;
  uncompleteTask: (id: string) => void;
  /** Changes a Task's content. Ignores blank input, mirroring editEntry. */
  renameTask: (id: string, content: string) => void;
  /** Writes the one `orderKey` a drag computed (task-reorder.ts's `reorderedTaskOrderKey`) — see TaskStore.reorder's own doc comment for why this never touches a sibling's row. */
  reorderTask: (id: string, orderKey: string) => void;
  /**
   * Writes the one `dayOrder` a Today drag computed (task-reorder.ts's
   * `reorderedTaskDayOrder`, issue #182) — the Today-shaped sibling of
   * `reorderTask` above, mirroring TaskStore.reorderToday's own doc
   * comment: leaves `orderKey` (this Task's Project position) untouched.
   */
  reorderTaskToday: (id: string, dayOrder: string) => void;
  removeTask: (id: string) => void;
  /**
   * Sets a Task's `date` (issue #169) — the one door every picker in Todo
   * goes through, rather than each calling `TaskStore.setDate` directly.
   */
  setTaskDate: (id: string, date: string | null) => void;
  /** Sets a Task's `deadline` (issue #169) — TaskStore.setDeadline throws on a timed value; DatePickerSheet only ever hands this a bare day, so that refusal is never reachable from a picker. */
  setTaskDeadline: (id: string, deadline: string | null) => void;
  /** Sets a Task's stored `priority` (1-4) — callers pass `storedPriorityOf(uiPriority)`, never the UI number directly (task-types.ts's own warning against open-coding the inversion). */
  setTaskPriority: (id: string, priority: number) => void;
  /**
   * Replaces a Task's `labelIds` wholesale — TaskStore.setLabelIds's own
   * doc comment on why "read, splice, write back the whole array" is the
   * contract rather than an add/remove pair. Issue #178's Task detail
   * view is this function's first caller with a UI of its own (add-
   * task-form.tsx's `resolveLabelIds` only ever sets Labels once, at
   * creation) — every setter above it in this file exists for the
   * identical reason: one door onto a TaskStore write, shared by every
   * picker rather than each opening its own.
   */
  setTaskLabels: (id: string, labelIds: string[]) => void;
  /**
   * Sets a Task's `description` (issue #180) — the one door the Task
   * detail view's own description field goes through, mirroring every
   * setter above's shape. `null` clears it back to "nothing chosen yet."
   */
  setTaskDescription: (id: string, description: string | null) => void;
  /**
   * A Project's own top-level Tasks (TaskStore.listByProject), `null` for
   * Inbox — issue #171's own replacement for reading the flat `tasks`
   * array above once Tasks can live in more than one place. An async
   * function rather than eagerly-loaded state, mirroring `resolveLabelIds`
   * on the Labels hook: TodoPage wraps this in its own `useQuery`, keyed
   * by query-keys.ts's `tasksInProjectQueryKey`, so it stays live off the
   * same TASKS_QUERY_KEY invalidation every other write here already
   * triggers.
   */
  listTasksInProject: (projectId: string | null) => Promise<Task[]>;
  /** A Task's own direct sub-tasks (TaskStore.listChildren) — the identical "async function, page keys its own query" shape as `listTasksInProject` above, via query-keys.ts's `taskChildrenQueryKey`. */
  listTaskChildren: (parentId: string) => Promise<Task[]>;
  /**
   * A Section's own direct members, active and completed alike
   * (TaskStore.listInSection) — this exists for exactly one caller, the
   * Section delete confirmation (issue #171's own acceptance criterion:
   * "names the count"), which needs the true number ProjectStore.deleteSection
   * is about to destroy rather than an approximation. Combined with
   * `listTaskDescendants` below the same way ProjectStore.deleteSection's
   * own doc comment describes its cascade, so the confirmation's own
   * count and the deletion it confirms can never quietly disagree.
   */
  listTasksInSection: (sectionId: string) => Promise<Task[]>;
  /** Every descendant of a Task, at any depth (TaskStore.listDescendants) — see `listTasksInSection` above for its one caller and why. */
  listTaskDescendants: (id: string) => Promise<Task[]>;
  /**
   * Advances a recurring Task to its next occurrence instead of completing
   * it (issue #170, TaskStore.advanceRecurring's own doc comment) — the
   * one door todo-page.tsx's `handleComplete` goes through for a Task
   * whose `dateString` isn't `null`, in place of `completeTask` above. A
   * recurring Task's checkbox never "un-ticks itself": the row leaves
   * Today's view or re-renders in place with the next date, and it never
   * enters `completedTasks`.
   */
  advanceRecurringTask: (id: string) => void;
  /**
   * Ends a recurring Task's series and files it as an ordinary completed
   * Task — Shift+Click on a recurring Task's checkbox (task-row.tsx), or
   * its touch-reachable "Complete and archive recurring task" button.
   * TaskStore.completeForever's own doc comment has the full reasoning.
   */
  completeForeverTask: (id: string) => void;
  /**
   * Moves an overdue Task to tomorrow (TaskStore.postpone's own doc
   * comment) — wired into Today's Overdue section as a quick action
   * beside the existing arbitrary-date Reschedule picker
   * (today-view.tsx), for the "postponing an overdue recurring task moves
   * it to tomorrow" case issue #170 names, though the underlying method
   * has nothing recurrence-specific about it and works on any overdue
   * Task with a `date`.
   */
  postponeTask: (id: string) => void;
  /** Moves a Task into `projectId` (or back to Inbox for `null`) — TaskStore.setProject's own doc comment. Also clears the Task's `sectionId`, since a Section belongs to exactly one Project. */
  setTaskProject: (id: string, projectId: string | null) => void;
  /** Files a Task into `sectionId` within whichever Project it already has, or clears it back to "no Section" for `null` — TaskStore.setSection's own doc comment. */
  setTaskSection: (id: string, sectionId: string | null) => void;
  /**
   * Reparents a Task under `parentId`, or back to top-level for `null` —
   * TaskStore.setParent's own doc comment names three shapes it refuses
   * (self-parenting, an unknown parent, and the four-level nesting cap).
   * Unlike every other setter on this interface, this one returns the
   * write's own Promise rather than firing-and-forgetting it: a keyboard
   * indent/drag-to-reparent gesture that walks into the depth cap needs a
   * legible outcome on screen (issue #171's brief), which means the
   * caller has to be able to `catch` this rather than have the failure
   * disappear into a mutation's own internal error state.
   */
  setTaskParent: (id: string, parentId: string | null) => Promise<void>;
}

/**
 * Owns Todo's Tasks for whichever view is mounted under EntryStoreLayout
 * (issue #168) — mirroring use-history.ts's shape deliberately: a query per
 * list TaskStore exposes, and a mutation per write, each running the same
 * "make the new state visible, then nudge Sync" step use-history.ts calls
 * `afterLocalWrite`.
 *
 * No paging query here the way useHistory's is (issue #79) — see
 * tasks-refresh.ts's own header comment for why Todo's Inbox has nothing
 * for a page boundary to bound.
 */
export function useTasks(
  store: EntryStore,
  taskStore: TaskStore,
  // Issue #182: needed only to pass through to requestSync's own
  // SyncStores bag below (sync-runner.ts's own doc comment on why every
  // stream is required there) — this hook does no read or write of its
  // own against any of the three.
  projectStore: ProjectStore,
  labelStore: LabelStore,
  commentStore: CommentStore,
  // Issue #184: Todo's activity log — required, alongside every other
  // store this hook already threads through to `requestSync`'s own
  // `SyncStores` bag. Also this hook's own means of recording every Task
  // act CONTEXT.md's Event entry and ADR 0056 name as recorded (see
  // `recordTaskEvent` below).
  eventStore: EventStore,
  deviceId: string,
): UseTasksResult {
  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: () => taskStore.list(),
  });
  const completedTasksQuery = useQuery({
    queryKey: COMPLETED_TASKS_QUERY_KEY,
    queryFn: () => taskStore.listCompleted(),
  });

  const tasks = tasksQuery.data ?? [];
  const completedTasks = completedTasksQuery.data ?? [];

  const { recordEvent } = useEvents(eventStore, deviceId);

  // Every setter below already reads the Task it's about to change off
  // `tasks`/`completedTasks` — TanStack Query's own already-loaded cache,
  // not a fresh store round trip — because a mutation needs the *old*
  // value to record a `last_*` diff (issue #184's own acceptance
  // criterion: "an event that changed a value can say what it changed
  // from"), and the render-time list already has it. Falls back to an
  // async `taskStore.get(id)` only when a caller reaches this before
  // either list has loaded — the identical race `addTask`'s own
  // `tasks.at(-1)?.orderKey ?? null` already tolerates for the empty-list
  // case, just written as a lookup instead of a default.
  async function findTask(id: string): Promise<Task | undefined> {
    return (
      tasks.find((t) => t.id === id) ??
      completedTasks.find((t) => t.id === id) ??
      (await taskStore.get(id))
    );
  }

  // The one place a Task act becomes an Event — every recorded mutation
  // below calls this exactly once, after resolving whatever `last_*`
  // value its own `extra` needs. `objectId`/`taskId` are always the
  // Task's own id here; `projectId` is read fresh from whichever Task the
  // caller hands in (the *resulting* state for a move, per this
  // function's own `recordTaskEvent` doc comment on `objectType: "task"`
  // events), not re-derived — a caller building a "moved" Event passes
  // the Task it already has in hand after its own store write, not
  // before.
  // `content` is always merged into `extra` — the cached label
  // `format-event.ts`'s own `describeEventLine` falls back to once a
  // Task can no longer be resolved live (deleted, or not yet Synced to
  // whichever Device is reading this Event). Every recorded act's own
  // `extra` needs to name its Task regardless of what else it needed to
  // say, not only the events (rename, add, delete) that already happened
  // to carry `content` for a diff's own sake — see this file's header
  // comment on `ActivityFeed`'s own gap-fix for why.
  function recordTaskEvent(
    task: Pick<Task, "id" | "projectId" | "content">,
    eventType: RecordEventInput["eventType"],
    extra: Record<string, unknown> | null = null,
  ): void {
    void recordEvent({
      eventType,
      objectType: "task",
      objectId: task.id,
      taskId: task.id,
      projectId: task.projectId,
      // `content` defaults to this Task's own — spread first, so a
      // caller's own explicit `extra.content` (renameTask's new title,
      // read against `before`'s *old* one) wins instead of being
      // silently clobbered back to the pre-rename value.
      extra: { content: task.content, ...extra },
    });
  }

  // use-history.ts's own `afterLocalWrite` comment explains why this step
  // is shared rather than repeated per mutation: the failure mode of
  // forgetting the Sync nudge is invisible on screen, so every mutation
  // below routes through the one place that remembers it.
  //
  // `requestSync` (issue #177's fix — #172 landed Task Sync itself but left
  // this hook's own nudge as a seam, per this comment's earlier revision)
  // coalesces against any sync already in flight, same as use-history.ts's
  // and backfill-tasks.ts's own calls — a Task mutation now reaches other
  // Devices as soon as this write commits, rather than waiting for the next
  // scheduled poll.
  const afterLocalWrite = async () => {
    await refreshTasks();
    void requestSync(
      { store, taskStore, projectStore, labelStore, commentStore, eventStore },
      deviceId,
    );
  };

  const addTaskMutation = useMutation({
    mutationFn: async (task: Task) => {
      await taskStore.upsert([task]);
      recordTaskEvent(task, "added");
    },
    onSuccess: afterLocalWrite,
  });

  function addTask(content: string, overrides: AddTaskOverrides = {}) {
    const trimmed = content.trim();
    if (trimmed === "") {
      return;
    }
    // Appended to the end of the active list — orderKeyBetween(lastKey,
    // null) sorts after every existing Task (order-key.ts's own doc
    // comment).
    const orderKey = orderKeyBetween(tasks.at(-1)?.orderKey ?? null, null);
    addTaskMutation.mutate({
      id: mintId(),
      deviceId,
      content: trimmed,
      completedAt: null,
      orderKey,
      // Starts at the same value as orderKey (issue #182) — the identical
      // bootstrap task-fields.ts's withDefaultDayOrder and mapping.ts's
      // fromWireTaskOutput both use for a Task with no Today position of
      // its own yet: "wherever its Project order already put it" is a
      // reasonable starting position for a Task that has never been
      // dragged in Today specifically.
      dayOrder: orderKey,
      createdAt: new Date().toISOString(),
      seq: null,
      syncedAt: null,
      deletedAt: null,
      // The **date is inherited from the origin** — the plan's own rule,
      // and Todoist's own context inheritance. `date` defaults to null, so
      // a Task captured in Inbox starts undated: Inbox is the capture
      // bucket, where a reader jots something down before deciding when,
      // or whether, to schedule it, and that is issue #169's "a Task
      // created in Todo starts undated."
      //
      // Today passes today's own day instead, and it has to. Adding a Task
      // while standing on Today and having it appear nowhere is not a
      // subtle failure — verified on the built app before this argument
      // was written: the row simply never appeared, because an undated
      // Task is by definition absent from every day-keyed view
      // (task-views.ts). The view a reader is looking at *is* the context
      // the rule inherits from; treating "created in Todo" as one
      // undifferentiated origin is what made a Task vanish as it was typed.
      //
      // Since issue #170, `overrides.date` can also carry an explicit
      // date/time token the reader typed, or a recognised recurrence's
      // first occurrence (quick-add-task.ts's `taskFieldsFromQuickAdd`) —
      // todo-page.tsx's own onAdd is what decides, per call, whether what
      // was typed should win over the view's inherited date; this
      // function only ever writes whatever single value it's handed.
      //
      // Every field below is `Task`'s own required, non-optional shape
      // (task-types.ts's own comment on why) stated explicitly at this
      // call site rather than left to an omitted key's default — `?? `'s
      // right-hand side is that explicit "nothing" state for a caller
      // (every pre-#170 one, and this file's own tests) with no overrides
      // of its own to give: undated, no deadline, priority 1
      // ("no priority"), no Labels, no recurrence.
      date: overrides.date ?? null,
      deadline: overrides.deadline ?? null,
      priority: overrides.priority ?? 1,
      labelIds: overrides.labelIds ?? [],
      dateString: overrides.dateString ?? null,
      // Issue #171's own three structural fields, following the identical
      // "the view a reader is standing in is the context" rule `date`
      // above already states and already learned the hard way (this
      // function's own comment on why an undated Today Task used to
      // vanish): `projectId` is `overrides.projectId ?? null` because a
      // Task added from Inbox is unfiled and one added from a Project's
      // own view inherits that Project — todo-page.tsx's own caller is
      // what decides which, the same way it already decides `captureDate`.
      // `sectionId` mirrors it for a Section's own add affordance.
      //
      // `parentId` is always `null` here, never an override — a new Task
      // is never minted as anyone's sub-task directly. Nesting one under
      // an existing Task is a deliberate, separate act (keyboard
      // indent/outdent onto TaskStore.setParent, todo-page.tsx) reached
      // after the Task already exists, exactly as dragging a freshly
      // added Task under a sibling is a second gesture in Todoist itself,
      // never something the add field predicts on a reader's behalf.
      projectId: overrides.projectId ?? null,
      sectionId: overrides.sectionId ?? null,
      parentId: null,
      // No Description yet (issue #180) — the same "nothing chosen yet"
      // state every other never-overridden field above starts in; there
      // is no AddTaskOverrides field for it, mirroring `parentId` above:
      // a Description is something the reader adds once the Task already
      // exists, in the Task's own detail view, not something the add
      // field predicts on their behalf.
      description: null,
    });
  }

  // ADR 0048's "ticking writes the Task; the body's marker follows as a
  // consequence" reads the same from either side of the act — an Entry's
  // own checkbox ticked writes the Task (entry-row.tsx's
  // `TaskReferenceItem`), and completing/uncompleting a Task from Todo
  // writes back every referencing Entry's own cache to match
  // (task-reference-sync.ts's `syncTaskReferenceChecked`, this function's
  // one non-Entry-initiated caller). `queryClient.invalidateQueries`
  // rather than `refreshNewestEntriesPage`: a referencing Entry can be
  // anywhere in History, not only on the newest loaded page, and this is
  // rare enough (a Task with an Entry Reference, completed from Todo, not
  // the ordinary "tap a Task row" path) that a full re-read is the right
  // trade rather than teaching this hook the newest-page-only shortcut
  // use-history.ts's own comment explains is a deliberate narrowing.
  const afterTaskReferenceWrite = async () => {
    await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
  };

  const completeTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await findTask(id);
      await taskStore.complete(id, new Date().toISOString());
      await syncTaskReferenceChecked(store, id, true);
      if (before) {
        recordTaskEvent(before, "completed");
      }
    },
    onSuccess: async () => {
      await afterLocalWrite();
      await afterTaskReferenceWrite();
    },
  });

  function completeTask(id: string) {
    completeTaskMutation.mutate(id);
  }

  const uncompleteTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await findTask(id);
      await taskStore.uncomplete(id);
      await syncTaskReferenceChecked(store, id, false);
      if (before) {
        recordTaskEvent(before, "uncompleted");
      }
    },
    onSuccess: async () => {
      await afterLocalWrite();
      await afterTaskReferenceWrite();
    },
  });

  function uncompleteTask(id: string) {
    uncompleteTaskMutation.mutate(id);
  }

  const renameTaskMutation = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      const before = await findTask(id);
      await taskStore.rename(id, content);
      // ADR 0048: "renaming a Task refreshes the cached label in every
      // Entry referencing it" — the one place in meologue an edit made in
      // Todo visibly changes text rendered in History.
      await syncTaskReferenceLabel(store, id, content);
      if (before) {
        recordTaskEvent(before, "updated", { content, lastContent: before.content });
      }
    },
    onSuccess: async () => {
      await afterLocalWrite();
      await afterTaskReferenceWrite();
    },
  });

  function renameTask(id: string, content: string) {
    const trimmed = content.trim();
    if (trimmed === "") {
      return;
    }
    renameTaskMutation.mutate({ id, content: trimmed });
  }

  const reorderTaskMutation = useMutation({
    mutationFn: ({ id, orderKey }: { id: string; orderKey: string }) =>
      taskStore.reorder(id, orderKey),
    onSuccess: afterLocalWrite,
  });

  function reorderTask(id: string, orderKey: string) {
    reorderTaskMutation.mutate({ id, orderKey });
  }

  const reorderTaskTodayMutation = useMutation({
    mutationFn: ({ id, dayOrder }: { id: string; dayOrder: string }) =>
      taskStore.reorderToday(id, dayOrder),
    onSuccess: afterLocalWrite,
  });

  function reorderTaskToday(id: string, dayOrder: string) {
    reorderTaskTodayMutation.mutate({ id, dayOrder });
  }

  const removeTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await findTask(id);
      await taskStore.remove(id);
      if (before) {
        recordTaskEvent(before, "deleted");
      }
    },
    onSuccess: afterLocalWrite,
  });

  function removeTask(id: string) {
    removeTaskMutation.mutate(id);
  }

  const setDateMutation = useMutation({
    mutationFn: async ({ id, date }: { id: string; date: string | null }) => {
      const before = await findTask(id);
      await taskStore.setDate(id, date);
      if (before) {
        recordTaskEvent(before, "updated", { date, lastDate: before.date });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function setTaskDate(id: string, date: string | null) {
    setDateMutation.mutate({ id, date });
  }

  const setDeadlineMutation = useMutation({
    mutationFn: async ({ id, deadline }: { id: string; deadline: string | null }) => {
      const before = await findTask(id);
      await taskStore.setDeadline(id, deadline);
      if (before) {
        recordTaskEvent(before, "updated", { deadline, lastDeadline: before.deadline });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function setTaskDeadline(id: string, deadline: string | null) {
    setDeadlineMutation.mutate({ id, deadline });
  }

  const setPriorityMutation = useMutation({
    mutationFn: async ({ id, priority }: { id: string; priority: number }) => {
      const before = await findTask(id);
      await taskStore.setPriority(id, priority);
      if (before) {
        recordTaskEvent(before, "updated", { priority, lastPriority: before.priority });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function setTaskPriority(id: string, priority: number) {
    setPriorityMutation.mutate({ id, priority });
  }

  const setLabelIdsMutation = useMutation({
    mutationFn: async ({ id, labelIds }: { id: string; labelIds: string[] }) => {
      const before = await findTask(id);
      await taskStore.setLabelIds(id, labelIds);
      if (before) {
        recordTaskEvent(before, "updated", { labelIds, lastLabelIds: before.labelIds });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function setTaskLabels(id: string, labelIds: string[]) {
    setLabelIdsMutation.mutate({ id, labelIds });
  }

  const setDescriptionMutation = useMutation({
    mutationFn: ({ id, description }: { id: string; description: string | null }) =>
      taskStore.setDescription(id, description),
    onSuccess: afterLocalWrite,
  });

  function setTaskDescription(id: string, description: string | null) {
    setDescriptionMutation.mutate({ id, description });
  }

  function listTasksInProject(projectId: string | null): Promise<Task[]> {
    return taskStore.listByProject(projectId);
  }

  function listTaskChildren(parentId: string): Promise<Task[]> {
    return taskStore.listChildren(parentId);
  }

  function listTasksInSection(sectionId: string): Promise<Task[]> {
    return taskStore.listInSection(sectionId);
  }

  function listTaskDescendants(id: string): Promise<Task[]> {
    return taskStore.listDescendants(id);
  }

  // Issue #170's three recurrence methods, and `completedAt`/`today`
  // supplied here — the identical `new Date().toISOString()`/day-key
  // pattern completeTaskMutation/setTaskDate's own picker-facing callers
  // already use above — rather than asked of every caller: a component
  // reaching for "complete this recurring Task" has no reason to think
  // about what timestamp that means any more than completeTask's own
  // caller does.
  const advanceRecurringMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await findTask(id);
      await taskStore.advanceRecurring(id, new Date().toISOString());
      // TaskStore.advanceRecurring's own doc comment: "this is a
      // completion event too — they set completedAt for real" (an ended
      // series) or advance dateString to the next occurrence, neither of
      // which this app's own taxonomy has a separate event_type for — an
      // Occurrence finishing is recorded as an ordinary "completed" Task
      // Event, mirroring completeForeverTask below.
      if (before) {
        recordTaskEvent(before, "completed");
      }
    },
    onSuccess: afterLocalWrite,
  });

  function advanceRecurringTask(id: string) {
    advanceRecurringMutation.mutate(id);
  }

  const completeForeverMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await findTask(id);
      await taskStore.completeForever(id, new Date().toISOString());
      if (before) {
        recordTaskEvent(before, "completed");
      }
    },
    onSuccess: afterLocalWrite,
  });

  function completeForeverTask(id: string) {
    completeForeverMutation.mutate(id);
  }

  const postponeMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await findTask(id);
      await taskStore.postpone(id, new Date().toISOString());
      // A reschedule like any other setDate call — TaskStore.postpone's
      // own doc comment: "a plain one-day shift of date." The resulting
      // value is read back from the store rather than recomputed here,
      // since this hook has no reason to duplicate ../recurrence/'s
      // tomorrowOf logic just to describe what already happened.
      const after = before ? await taskStore.get(id) : undefined;
      if (before) {
        recordTaskEvent(before, "updated", { date: after?.date ?? null, lastDate: before.date });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function postponeTask(id: string) {
    postponeMutation.mutate(id);
  }

  // Issue #171's three structural setters. `setTaskProject`/`setTaskSection`
  // follow every setter above's fire-and-forget shape: neither one can
  // meaningfully fail against a live Task (TaskStore.setProject/setSection's
  // own doc comments — a dangling or cross-Project reference is an
  // accepted, transient state, not a refusal). `setTaskParent` is
  // deliberately different — see its own doc comment below.
  const setProjectMutation = useMutation({
    mutationFn: async ({ id, projectId }: { id: string; projectId: string | null }) => {
      const before = await findTask(id);
      await taskStore.setProject(id, projectId);
      // The "moved" Event's own snapshotted `projectId` is the
      // *resulting* Project (../../../packages/core/src/event-types.ts's
      // own `projectId` doc comment) — this Task's move is read as
      // having happened in the place it moved *to*, mirroring how a
      // real reference implementation files a "moved" activity row under
      // the destination.
      if (before) {
        recordTaskEvent({ id, projectId, content: before.content }, "moved", {
          projectId,
          lastProjectId: before.projectId,
        });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function setTaskProject(id: string, projectId: string | null) {
    setProjectMutation.mutate({ id, projectId });
  }

  const setSectionMutation = useMutation({
    mutationFn: async ({ id, sectionId }: { id: string; sectionId: string | null }) => {
      const before = await findTask(id);
      await taskStore.setSection(id, sectionId);
      if (before) {
        recordTaskEvent(before, "moved", { sectionId, lastSectionId: before.sectionId });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function setTaskSection(id: string, sectionId: string | null) {
    setSectionMutation.mutate({ id, sectionId });
  }

  // TaskStore.setParent throws on the three shapes its own doc comment
  // names — most reachably from the UI, the four-level nesting cap
  // (MAX_TASK_NESTING_DEPTH, @meologue/core) a keyboard indent or a
  // drag-to-reparent can genuinely walk a reader into. `mutateAsync`,
  // not `mutate`, and the resulting Promise handed back to the caller
  // unmutated: every other mutation in this file swallows its own
  // rejection into TanStack Query's own mutation.error state, which is
  // the right call when nothing on screen needs to react to a failure —
  // but 171-brief.md's own brief is explicit that a caller here must
  // "decide what the UI does with that and make it legible rather than a
  // swallowed exception," and the caller (todo-page.tsx's keyboard
  // handler) is what owns that decision, not this hook. Swallowing it
  // here would be exactly the silent failure that brief warns against.
  const setParentMutation = useMutation({
    mutationFn: async ({ id, parentId }: { id: string; parentId: string | null }) => {
      const before = await findTask(id);
      await taskStore.setParent(id, parentId);
      if (before) {
        recordTaskEvent(before, "moved", { parentId, lastParentId: before.parentId });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function setTaskParent(id: string, parentId: string | null): Promise<void> {
    return setParentMutation.mutateAsync({ id, parentId });
  }

  return {
    tasks,
    completedTasks,
    addTask,
    completeTask,
    uncompleteTask,
    renameTask,
    reorderTask,
    reorderTaskToday,
    removeTask,
    setTaskDate,
    setTaskDeadline,
    setTaskPriority,
    setTaskLabels,
    setTaskDescription,
    listTasksInProject,
    listTaskChildren,
    listTasksInSection,
    listTaskDescendants,
    advanceRecurringTask,
    completeForeverTask,
    postponeTask,
    setTaskProject,
    setTaskSection,
    setTaskParent,
  };
}
