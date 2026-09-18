import { useState } from "react";
import { COMPLETED_TASKS_PAGE_SIZE } from "@/lib/completed-tasks-page-size";

/**
 * Issue #358: how many of a completed block's own rows are on screen right
 * now, and the "Load more" door onto the rest — shared by every caller that
 * renders a completed-Tasks block below its own active list
 * (`task-tree.tsx`, `filter-view.tsx`, `task-search-page.tsx`), so the
 * paging arithmetic and its one edge case (`Math.min`, below) exist once.
 *
 * There is no server round trip to make here: `TaskStore.listCompleted()`
 * already hands every caller the *whole*, flat, newest-first list up front
 * (`use-tasks.ts`'s own doc comment) — this app is local-first, so "load
 * more" is windowing over an array already sitting in memory, not a
 * paginated fetch. That is also why both live drives behind `ROW-14`
 * (parity-ledger.md) matter here specifically: they proved Todoist's own
 * `+N completed tasks` control is a Load-more page-size hint, not a
 * counter that grows as more Tasks are completed — the count this hook
 * reports (`remaining`) falls as `loadMore` is clicked and rises only when
 * `totalCount` itself grows (a fresh completion, newest-first, landing
 * ahead of `visibleCount`'s own window), never the other way round.
 *
 * `pageSize` defaults to `COMPLETED_TASKS_PAGE_SIZE` rather than every
 * caller importing that constant separately, but still takes it as a
 * parameter — nothing here assumes there is only ever one page size in the
 * app, only that today there is.
 */
export function useCompletedTasksPage(totalCount: number, pageSize = COMPLETED_TASKS_PAGE_SIZE) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  // Never more than `totalCount` — a completed Task can also be un-completed
  // out from under an open "Load more" window (issue #358's own
  // `onUncomplete` door), which shrinks `totalCount` without this hook
  // hearing about it directly; clamping on read, not on write, is what
  // keeps `remaining` from ever going negative in that case.
  const clampedVisibleCount = Math.min(visibleCount, totalCount);
  const remaining = Math.max(0, totalCount - clampedVisibleCount);

  function loadMore() {
    setVisibleCount((count) => Math.min(totalCount, count + pageSize));
  }

  return { visibleCount: clampedVisibleCount, remaining, loadMore };
}
