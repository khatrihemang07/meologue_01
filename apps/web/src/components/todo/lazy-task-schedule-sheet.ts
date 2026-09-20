import { lazy } from "react";

/**
 * `task-schedule-sheet.tsx`'s own component, behind a lazy boundary from
 * `todo-page.tsx` — the same move `lazy-task-detail-view.ts` makes for the
 * detail modal, for the same reason: Todo's route had 651 bytes of
 * headroom left against its ceiling (this ticket's own brief) with two
 * tickets still to land on it.
 *
 * This chunk carries more than its own ~9 KB of source: it statically
 * imports `task-schedule-popover.tsx` (issue #227's Todoist-style
 * scheduler, `date-fns` plus `ui/popover.tsx`'s Radix `Popover`) — the
 * ~35 KB `check-bundle-size.mjs`'s own `CHUNK_BUDGETS` comment on
 * `todo-page.tsx` already attributes to "the shared portion, not Todo's
 * own code." None of that is needed to render a Task row, only to open a
 * scheduler. (Issue #376 dropped this file's own `date-picker-sheet.tsx`
 * import along with Deadline's picker; `task-schedule-popover.tsx` still
 * pulls it in for `date`, so it stays part of this chunk regardless.)
 *
 * `todo-page.tsx` is the only caller this wrapper serves. `composer-page.tsx`
 * keeps its own **static** import of `task-schedule-sheet.tsx` — Composer
 * is a separate route with its own budget, already large
 * (`CHUNK_BUDGETS["src/pages/composer-page.tsx"]`), and changing how it
 * reaches this component is outside what this ticket asked for.
 *
 * Gated by `todo-page.tsx`'s own `schedulingTask !== null` check,
 * unchanged by this split: nothing about opening a scheduler happens on
 * first paint of `/todo/inbox` or any other Todo view, so the `import()`
 * below only ever fires once a reader actually asks to schedule a Task.
 */
export const LazyTaskScheduleSheet = lazy(() =>
  import("@/components/todo/task-schedule-sheet").then((m) => ({
    default: m.TaskScheduleSheet,
  })),
);
