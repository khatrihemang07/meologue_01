/**
 * Issue #358: how many completed Tasks `useCompletedTasksPage` (hooks/
 * use-completed-tasks-page.ts) reveals per "Load more" click, shared by
 * every surface that renders a completed block below its own active list —
 * Inbox/Project (`task-tree.tsx`), a Filter's own matches (`filter-view.tsx`)
 * and Search's own matches (`task-search-page.tsx`) — so the three don't
 * each pick their own number.
 *
 * Both live drives behind `ROW-14` (parity-ledger.md) established that
 * Todoist's own `+N completed tasks` control is a Load-more page-size hint
 * rather than a growing expander — the number itself (Todoist showed 48 per
 * page on the account driven) was never the thing measured, only the
 * *shape* (paginate, don't just expand). 10 is this app's own, unmeasured
 * choice for that page size — small enough that a reader who never wants to
 * see completed history at all pays almost nothing for the setting being on,
 * large enough that a normal day's worth of completions rarely needs a
 * second click.
 */
export const COMPLETED_TASKS_PAGE_SIZE = 10;
