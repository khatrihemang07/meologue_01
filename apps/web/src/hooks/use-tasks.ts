import type { EntryStore, Task, TaskStore } from "@meologue/core";
import { hasTime, mintId, orderKeyBetween } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  duration?: number | null;
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
  removeTask: (id: string) => void;
  /**
   * Sets a Task's `date` (issue #169) — the one door every picker in Todo
   * goes through, rather than each calling `TaskStore.setDate` directly.
   * Dropping to an undated or all-day value while `duration` still holds a
   * value from an earlier timed `date` is this function's own job to fix,
   * not the store's: TaskStore.setDuration's own doc comment is explicit
   * that "requires a date that carries a time" is checked against the
   * Task's *current* `date` at the moment `setDuration` runs, and
   * `setDate` "does not need a mirror-image check … changing `date` never
   * touches `duration`'s stored value" — meaning the store leaves an
   * inconsistent row (a `duration` sitting on an all-day Task) exactly as
   * valid as any other write, and expects the caller who just removed the
   * time to also clear it. This hook is that caller for every picker in
   * the app, so it happens here once rather than once per picker.
   */
  setTaskDate: (id: string, date: string | null) => void;
  /** Sets a Task's `deadline` (issue #169) — TaskStore.setDeadline throws on a timed value; DatePickerSheet only ever hands this a bare day, so that refusal is never reachable from a picker. */
  setTaskDeadline: (id: string, deadline: string | null) => void;
  /** Sets a Task's `duration` in minutes (issue #169) — TaskStore.setDuration throws without a timed `date` or above 1440; the picker that calls this disables itself rather than relying on the throw (task-schedule-sheet.tsx). */
  setTaskDuration: (id: string, duration: number | null) => void;
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
    void requestSync(store, taskStore, deviceId);
  };

  const addTaskMutation = useMutation({
    mutationFn: (task: Task) => taskStore.upsert([task]),
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
    addTaskMutation.mutate({
      id: mintId(),
      deviceId,
      content: trimmed,
      completedAt: null,
      orderKey: orderKeyBetween(tasks.at(-1)?.orderKey ?? null, null),
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
      // of its own to give: undated, no deadline, no duration, priority 1
      // ("no priority"), no Labels, no recurrence.
      date: overrides.date ?? null,
      deadline: overrides.deadline ?? null,
      duration: overrides.duration ?? null,
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
      await taskStore.complete(id, new Date().toISOString());
      await syncTaskReferenceChecked(store, id, true);
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
      await taskStore.uncomplete(id);
      await syncTaskReferenceChecked(store, id, false);
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
      await taskStore.rename(id, content);
      // ADR 0048: "renaming a Task refreshes the cached label in every
      // Entry referencing it" — the one place in meologue an edit made in
      // Todo visibly changes text rendered in History.
      await syncTaskReferenceLabel(store, id, content);
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

  const removeTaskMutation = useMutation({
    mutationFn: (id: string) => taskStore.remove(id),
    onSuccess: afterLocalWrite,
  });

  function removeTask(id: string) {
    removeTaskMutation.mutate(id);
  }

  const setDateMutation = useMutation({
    mutationFn: ({ id, date }: { id: string; date: string | null }) => taskStore.setDate(id, date),
    onSuccess: afterLocalWrite,
  });

  const setDurationMutation = useMutation({
    mutationFn: ({ id, duration }: { id: string; duration: number | null }) =>
      taskStore.setDuration(id, duration),
    onSuccess: afterLocalWrite,
  });

  function setTaskDate(id: string, date: string | null) {
    setDateMutation.mutate({ id, date });
    // See UseTasksResult.setTaskDate's own doc comment for why this
    // follow-up write exists. `tasks` (this closure's own active list) is
    // read synchronously here rather than after `setDateMutation` settles:
    // the two writes race against the same row regardless of ordering —
    // TaskStore's per-field setters clear `seq` independently, and no
    // Sync exists yet to interleave with (issue #172) — so there is no
    // correctness reason to wait, only latency to lose by doing so.
    if (!hasTime(date)) {
      const current = tasks.find((t) => t.id === id);
      if (current !== undefined && current.duration !== null) {
        setDurationMutation.mutate({ id, duration: null });
      }
    }
  }

  const setDeadlineMutation = useMutation({
    mutationFn: ({ id, deadline }: { id: string; deadline: string | null }) =>
      taskStore.setDeadline(id, deadline),
    onSuccess: afterLocalWrite,
  });

  function setTaskDeadline(id: string, deadline: string | null) {
    setDeadlineMutation.mutate({ id, deadline });
  }

  function setTaskDuration(id: string, duration: number | null) {
    setDurationMutation.mutate({ id, duration });
  }

  const setPriorityMutation = useMutation({
    mutationFn: ({ id, priority }: { id: string; priority: number }) =>
      taskStore.setPriority(id, priority),
    onSuccess: afterLocalWrite,
  });

  function setTaskPriority(id: string, priority: number) {
    setPriorityMutation.mutate({ id, priority });
  }

  const setLabelIdsMutation = useMutation({
    mutationFn: ({ id, labelIds }: { id: string; labelIds: string[] }) =>
      taskStore.setLabelIds(id, labelIds),
    onSuccess: afterLocalWrite,
  });

  function setTaskLabels(id: string, labelIds: string[]) {
    setLabelIdsMutation.mutate({ id, labelIds });
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
    mutationFn: (id: string) => taskStore.advanceRecurring(id, new Date().toISOString()),
    onSuccess: afterLocalWrite,
  });

  function advanceRecurringTask(id: string) {
    advanceRecurringMutation.mutate(id);
  }

  const completeForeverMutation = useMutation({
    mutationFn: (id: string) => taskStore.completeForever(id, new Date().toISOString()),
    onSuccess: afterLocalWrite,
  });

  function completeForeverTask(id: string) {
    completeForeverMutation.mutate(id);
  }

  const postponeMutation = useMutation({
    mutationFn: (id: string) => taskStore.postpone(id, new Date().toISOString()),
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
    mutationFn: ({ id, projectId }: { id: string; projectId: string | null }) =>
      taskStore.setProject(id, projectId),
    onSuccess: afterLocalWrite,
  });

  function setTaskProject(id: string, projectId: string | null) {
    setProjectMutation.mutate({ id, projectId });
  }

  const setSectionMutation = useMutation({
    mutationFn: ({ id, sectionId }: { id: string; sectionId: string | null }) =>
      taskStore.setSection(id, sectionId),
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
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      taskStore.setParent(id, parentId),
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
    removeTask,
    setTaskDate,
    setTaskDeadline,
    setTaskDuration,
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
    setTaskSection,
    setTaskParent,
  };
}
