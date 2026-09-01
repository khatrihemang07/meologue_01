import { queryClient } from "@/lib/query-client";
import { TASKS_QUERY_KEY } from "@/lib/query-keys";

/**
 * The Task-shaped sibling of entries-pagination.ts's refreshNewestEntriesPage
 * — a sibling module, not a branch inside that one, because the two entities
 * genuinely need different machinery rather than a shared function with an
 * `if (entity === "task")` down the middle.
 *
 * entries-pagination.ts exists mostly to solve one problem: History is an
 * infinite query (issue #79's fifty-at-a-time window), and TanStack Query's
 * default invalidation of an infinite query refetches every page it holds,
 * sequentially — so refreshNewestEntriesPage does a bounded, boundary-aware
 * rewrite of page 0 alone instead. Todo's Inbox has nothing like that: Task
 * Sync doesn't exist until issue #172 (this ticket wires the refresh below
 * and leaves the Sync nudge itself as a seam — see use-tasks.ts's own
 * `afterLocalWrite`), and even once it does, TaskStore.list()/
 * listCompleted() each return the whole list in one call, with no cursor
 * and no page to bound. A plain invalidateQueries is not a simplified copy
 * of refreshNewestEntriesPage's reasoning; it is the whole of what a flat,
 * unpaginated query needs, which is why it lives in its own small file
 * rather than a case inside a function built to solve a problem this data
 * doesn't have.
 */
export async function refreshTasks(): Promise<void> {
  // A prefix match (TanStack Query's default) — invalidating TASKS_QUERY_KEY
  // also invalidates COMPLETED_TASKS_QUERY_KEY (query-keys.ts), since
  // completing or uncompleting a Task always moves it between both lists at
  // once and a caller that refreshed only one would leave the other showing
  // a Task that no longer belongs there.
  await queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
}
