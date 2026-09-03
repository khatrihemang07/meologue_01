import type { Comment, CommentStore } from "@meologue/core";
import { mintId } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
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
 */
export function useComments(commentStore: CommentStore, deviceId: string): UseCommentsResult {
  const commentsQuery = useQuery({
    queryKey: COMMENTS_QUERY_KEY,
    queryFn: () => commentStore.list(),
  });

  const comments = commentsQuery.data ?? [];

  const afterLocalWrite = () => queryClient.invalidateQueries({ queryKey: COMMENTS_QUERY_KEY });

  const upsertMutation = useMutation({
    mutationFn: (newComment: Comment) => commentStore.upsert([newComment]),
    onSuccess: afterLocalWrite,
  });

  function addComment(taskId: string, text: string) {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    upsertMutation.mutate({
      id: mintId(),
      deviceId,
      taskId,
      text: trimmed,
      createdAt: new Date().toISOString(),
      seq: null,
      syncedAt: null,
      deletedAt: null,
    });
  }

  const editMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => commentStore.edit(id, text),
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
    mutationFn: (id: string) => commentStore.remove(id),
    onSuccess: afterLocalWrite,
  });

  function removeComment(id: string) {
    removeMutation.mutate(id);
  }

  return { comments, addComment, editComment, removeComment };
}
