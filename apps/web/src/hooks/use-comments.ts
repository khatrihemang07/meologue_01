import type { Comment, CommentStore, EventStore, TaskStore } from "@meologue/core";
import { mintId } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEvents } from "@/hooks/use-events";
import { queryClient } from "@/lib/query-client";
import { COMMENTS_QUERY_KEY } from "@/lib/query-keys";

export interface UseCommentsResult {
  /**
   * Every live Comment across every Task (CommentStore.list()'s own
   * guarantee: oldest first) — task-row.tsx's own comment-count badge
   * and the Task detail view's own thread both read off this one list,
   * narrowed client-side by comment-counts.ts's own helpers rather than
   * this hook growing a second, per-Task query.
   */
  comments: Comment[];
  /** Adds a new Comment to `taskId`, minted on this Device — ignores blank input, mirroring addTask/sendEntry. */
  addComment: (taskId: string, text: string) => void;
  /** Changes a Comment's text — ignores blank input, mirroring renameTask. */
  editComment: (id: string, text: string) => void;
  removeComment: (id: string) => void;
}

/**
 * Owns Todo's Comments for whichever view is mounted under
 * EntryStoreLayout (issue #180) — the Comment-shaped sibling of
 * use-labels.ts, following its exact shape (a query, a mutation per
 * write, no `requestSync` nudge — Comment Sync doesn't exist yet, issue
 * #182) for the identical reason that file's own header comment gives
 * for mirroring use-history.ts.
 *
 * `taskStore` (issue #184) is read-only here — every Comment Event this
 * hook records needs its parent Task's own `projectId` for the
 * per-Project surface (../../../packages/core/src/event-types.ts's own
 * `projectId` doc comment), and `CommentStore` alone has no way to
 * answer that. `eventStore` is Todo's activity log itself — recording
 * add and delete matches Todoist's own activity log verbatim (CMT-06,
 * re-driven live, flow 5: `You commented {content} on {task}` /
 * `You deleted a comment from {task}`). Editing a comment records
 * *nothing* — also CMT-06's own live finding, and the opposite of this
 * hook's first cut, which logged an "Edited a comment" Event Todoist has
 * no equivalent for; `editComment` below no longer calls
 * `recordCommentEvent` at all, so Todoist's "no event" is matched at the
 * source rather than papered over at render time. (An "updated" comment
 * Event can still turn up from an old store or a restored backup written
 * before this fix — `format-event.ts`'s `isRenderableEvent` is what
 * keeps a stale one like that out of the feed.)
 */
export function useComments(
  commentStore: CommentStore,
  taskStore: TaskStore,
  eventStore: EventStore,
  deviceId: string,
): UseCommentsResult {
  const commentsQuery = useQuery({
    queryKey: COMMENTS_QUERY_KEY,
    queryFn: () => commentStore.list(),
  });

  const comments = commentsQuery.data ?? [];

  const { recordEvent } = useEvents(eventStore, deviceId);

  async function recordCommentEvent(
    comment: Pick<Comment, "id" | "taskId">,
    eventType: "added" | "updated" | "deleted",
    extra: Record<string, unknown> | null,
  ): Promise<void> {
    const task = await taskStore.get(comment.taskId);
    // `taskContent` is always merged in — the cached label
    // `format-event.ts`'s own `describeEventLine` falls back to for
    // "which Task was this Comment on" once the Task can no longer be
    // resolved live, the identical reasoning use-tasks.ts's
    // `recordTaskEvent` gives for its own `content` merge.
    await recordEvent({
      eventType,
      objectType: "comment",
      objectId: comment.id,
      taskId: comment.taskId,
      projectId: task?.projectId ?? null,
      extra: { ...extra, taskContent: task?.content ?? null },
    });
  }

  const afterLocalWrite = () => queryClient.invalidateQueries({ queryKey: COMMENTS_QUERY_KEY });

  const upsertMutation = useMutation({
    mutationFn: async (newComment: Comment) => {
      await commentStore.upsert([newComment]);
      await recordCommentEvent(newComment, "added", { text: newComment.text });
    },
    onSuccess: afterLocalWrite,
  });

  function addComment(taskId: string, text: string) {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    const now = new Date().toISOString();
    upsertMutation.mutate({
      id: mintId(),
      deviceId,
      taskId,
      text: trimmed,
      createdAt: now,
      // Issue #196: a freshly-created row's own updatedAt starts equal
      // to createdAt — the same single clock read, not a second one.
      updatedAt: now,
      seq: null,
      syncedAt: null,
      deletedAt: null,
    });
  }

  const editMutation = useMutation({
    // CMT-06 (re-driven live, flow 5): Todoist's own activity log records
    // no Event at all for a comment edit, so this mutation no longer calls
    // `recordCommentEvent` the way `upsertMutation`/`removeMutation` still
    // do — the fix belongs here, at the source, rather than in how the
    // feed renders an "updated" comment Event after the fact.
    mutationFn: async ({ id, text }: { id: string; text: string }) => {
      await commentStore.edit(id, text);
    },
    onSuccess: afterLocalWrite,
  });

  function editComment(id: string, text: string) {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    editMutation.mutate({ id, text: trimmed });
  }

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const before = await commentStore.get(id);
      await commentStore.remove(id);
      if (before) {
        await recordCommentEvent(before, "deleted", { text: before.text });
      }
    },
    onSuccess: afterLocalWrite,
  });

  function removeComment(id: string) {
    removeMutation.mutate(id);
  }

  return { comments, addComment, editComment, removeComment };
}
