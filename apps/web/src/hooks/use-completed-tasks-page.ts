import { useState } from "react";
import { COMPLETED_TASKS_PAGE_SIZE } from "@/lib/completed-tasks-page-size";

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
