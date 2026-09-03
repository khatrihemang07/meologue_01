import type { Comment } from "@meologue/core";

/**
 * The two ways task-row.tsx and task-detail-view.tsx each read the one
 * flat `comments` list `useComments` (use-comments.ts) already loads —
 * the identical "core/the store returns the flat rows, a small pure
 * function on this side groups them" split group-today-tasks.ts already
 * uses for Today, applied here instead of CommentStore growing a
 * per-Task query of its own: a personal task list's own Comments sit at
 * a scale (CommentStore.list()'s own doc comment) where filtering a
 * list already in memory costs nothing extra.
 */

/** A Task's own comment count — task-row.tsx's own speech-bubble badge, only ever rendered when this is non-zero. */
export function commentCountForTask(comments: readonly Comment[], taskId: string): number {
  return comments.reduce((count, c) => (c.taskId === taskId ? count + 1 : count), 0);
}

/** One Task's own thread, in the identical oldest-first order CommentStore.list()/listByTask() both already guarantee. */
export function commentsForTask(comments: readonly Comment[], taskId: string): Comment[] {
  return comments.filter((c) => c.taskId === taskId);
}
