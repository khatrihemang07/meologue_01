/**
 * Validation for Comment's own fields — the Comment-shaped sibling of
 * label-fields.ts/task-fields.ts, called from every CommentStore
 * implementation's setter rather than re-derived by each, for the
 * identical reason those files' own header comments give: a rule checked
 * in only one implementation is a rule the shared contract suite
 * (test-support/comment-store-contract.ts) would never catch the other
 * implementation getting wrong.
 */

/** Throws on an empty or whitespace-only `text` — a Comment with no words isn't a lesser Comment, it's not a Comment, mirroring label-fields.ts's assertValidLabelName. */
export function assertValidCommentText(text: string): void {
  if (text.trim() === "") {
    throw new Error("comment text must not be empty");
  }
}
