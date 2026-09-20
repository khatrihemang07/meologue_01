import { lazy } from "react";

/**
 * `task-schedule-popover.tsx`'s own component, behind a lazy boundary from
 * `quick-add-content.tsx` — issue #416's fix for the same regression
 * `lazy-task-schedule-sheet.ts`'s own header comment describes: this file
 * carries `date-fns` plus `ui/popover.tsx`'s Radix `Popover` and
 * `ui/calendar.tsx`'s `Calendar` (issue #227's Todoist-style scheduler,
 * ~35 KB), none of which is needed to render the composer itself, only to
 * open its date chip's picker.
 *
 * `quick-add-content.tsx` had imported `TaskSchedulePopover` statically,
 * which made that whole dependency graph eagerly reachable from
 * `todo-page.tsx` again (`AddTaskForm` and `QuickAddDialog` both reach the
 * composer without a lazy boundary of their own) — exactly what
 * `lazy-task-schedule-sheet.ts` was built to keep out. This wrapper closes
 * that path the same way `quick-add-content.tsx` already closes it for
 * `LazyTaskTitleEditor`/`LazyTaskDescriptionEditor`: one shared lazy
 * chunk, `<Suspense fallback={null}>` at the call site, `import()` firing
 * only once a reader actually opens the date chip.
 */
export const LazyTaskSchedulePopover = lazy(() =>
  import("@/components/todo/task-schedule-popover").then((m) => ({
    default: m.TaskSchedulePopover,
  })),
);
