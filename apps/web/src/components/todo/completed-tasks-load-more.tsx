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
