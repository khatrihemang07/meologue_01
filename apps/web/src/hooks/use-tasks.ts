import type { Task, TaskStore } from "@meologue/core";
import { mintId, orderKeyBetween } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { COMPLETED_TASKS_QUERY_KEY, TASKS_QUERY_KEY } from "@/lib/query-keys";
import { refreshTasks } from "@/lib/tasks-refresh";

export interface UseTasksResult {
  /** Active Tasks, in (orderKey, id) order — TaskStore.list()'s own guarantee (ADR 0050). */
  tasks: Task[];
  /** Completed Tasks, newest completion first — TaskStore.listCompleted(). */
  completedTasks: Task[];
  /** Creates a Task from plain text, appended to the end of the active list. Ignores blank input, mirroring sendEntry. */
  addTask: (content: string) => void;
  completeTask: (id: string) => void;
  uncompleteTask: (id: string) => void;
  /** Changes a Task's content. Ignores blank input, mirroring editEntry. */
  renameTask: (id: string, content: string) => void;
  /** Writes the one `orderKey` a drag computed (task-reorder.ts's `reorderedTaskOrderKey`) — see TaskStore.reorder's own doc comment for why this never touches a sibling's row. */
  reorderTask: (id: string, orderKey: string) => void;
  removeTask: (id: string) => void;
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
export function useTasks(taskStore: TaskStore, deviceId: string): UseTasksResult {
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
  // The nudge itself is the seam, not yet the call. Task Sync doesn't exist
  // until issue #172 (ADR 0047's Consequence 3 — a second entity stream is
  // its own protocol-version change, not something this ticket's TaskStore
  // reaches for on its own), and sync-runner.ts's `requestSync` is typed to
  // `EntryStore` specifically — there is no Task-shaped version of it to
  // call yet. #172 lands its own `requestSync`-equivalent on the line
  // directly below the comment, in this exact function, rather than this
  // hook growing a parallel `afterLocalWrite` later that has to be kept in
  // step with this one by hand.
  const afterLocalWrite = async () => {
    await refreshTasks();
    // Seam for issue #172's Task Sync nudge — see this function's own
    // comment above.
  };

  const addTaskMutation = useMutation({
    mutationFn: (task: Task) => taskStore.upsert([task]),
    onSuccess: afterLocalWrite,
  });

  function addTask(content: string) {
    const trimmed = content.trim();
    if (trimmed === "") {
      return;
    }
    // Appended to the end of the active list — orderKeyBetween(lastKey,
    // null) sorts after every existing Task (order-key.ts's own doc
    // comment). A Task created in Todo is undated (the plan's own "default
    // date is inherited from origin" rule), so "the end" is the only
    // position that means anything without a due date to sort by yet.
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
    });
  }

  const completeTaskMutation = useMutation({
    mutationFn: (id: string) => taskStore.complete(id, new Date().toISOString()),
    onSuccess: afterLocalWrite,
  });

  function completeTask(id: string) {
    completeTaskMutation.mutate(id);
  }

  const uncompleteTaskMutation = useMutation({
    mutationFn: (id: string) => taskStore.uncomplete(id),
    onSuccess: afterLocalWrite,
  });

  function uncompleteTask(id: string) {
    uncompleteTaskMutation.mutate(id);
  }

  const renameTaskMutation = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => taskStore.rename(id, content),
    onSuccess: afterLocalWrite,
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

  return {
    tasks,
    completedTasks,
    addTask,
    completeTask,
    uncompleteTask,
    renameTask,
    reorderTask,
    removeTask,
  };
}
