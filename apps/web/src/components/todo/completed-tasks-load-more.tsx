/**
 * Issue #358: the "+N completed tasks" control both Todoist platforms show
 * below a relocated completed block (`ROW-14`, parity-ledger.md) — a
 * Load-more pagination hint, not a growing expander (the Android drive
 * behind that row read the same count before, and after, completing and
 * then deleting a probe Task). Every caller that renders a completed block
 * (`task-tree.tsx`, `filter-view.tsx`, `task-search-page.tsx`) renders one
 * of these rather than writing the "N remaining, singular/plural, hide once
 * zero" logic itself.
 *
 * Renders nothing once `remaining` is zero — the acceptance criterion this
 * ticket names directly: the control appears only when there are older
 * completed Tasks beyond what's already on screen, not permanently once a
 * list has ever had one completed row.
 */
export function CompletedTasksLoadMore({
  remaining,
  onLoadMore,
}: {
  /** Completed Tasks not yet revealed — `useCompletedTasksPage`'s own `remaining` (hooks/use-completed-tasks-page.ts). */
  remaining: number;
  onLoadMore: () => void;
}) {
  if (remaining <= 0) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onLoadMore}
      className="px-3 py-2 text-left text-muted-foreground text-sm hover:text-foreground"
    >
      +{remaining} completed {remaining === 1 ? "task" : "tasks"}
    </button>
  );
}
