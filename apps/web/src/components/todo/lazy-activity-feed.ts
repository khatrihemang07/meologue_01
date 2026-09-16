import { lazy } from "react";

/**
 * `activity-feed.tsx`'s own component, behind a lazy boundary — the
 * identical "keep it out of the eager chunk" move `lazy-task-title-
 * editor.ts` and `lazy-destructive-confirm-dialog.ts` already make.
 *
 * Two callers, both gating it behind a real user gesture rather than
 * rendering it on first paint: `todo-page.tsx`'s own `backgroundView.view
 * === "activity"` branch (issue #184 — a reader has to navigate to the
 * Activity view specifically; Inbox/Today are the default) and issue
 * #288's `TaskActivityDialog` in `task-detail-view.tsx` (a reader has to
 * open "View activity" from the overflow menu). A static import at either
 * site loads this component's code — plus `format-event.ts`'s event-line
 * formatting it pulls in — on every visit to that surface regardless of
 * whether the reader ever looks at Activity, which is exactly what issue
 * #288's own move off the task detail screen was for.
 *
 * One shared lazy chunk, not one per caller, the same reasoning
 * `lazy-destructive-confirm-dialog.ts`'s own header comment gives for
 * Device Restore and Server Restore: importing the identical specifier
 * from both `todo-page.tsx` and `task-detail-view.tsx` means Rollup
 * places `activity-feed.tsx` in exactly one lazy chunk regardless of
 * which surface a reader opens Activity from first.
 *
 * `todo-page.tsx`'s own block is already a plain `{view === "activity" &&
 * (...)}` conditional, so `<ActivityFeed>` there was never even created,
 * let alone mounted, until that view is active — swapping it for this
 * lazy wrapper costs nothing extra. `task-detail-view.tsx`'s own
 * `TaskActivityDialog` additionally gates its `<Suspense>` behind its own
 * `open` prop directly (not just Radix `Dialog`'s internal Presence),
 * matching `lazy-destructive-confirm-dialog.ts`'s own warning that
 * mounting a lazy component unconditionally, even hidden, can trigger its
 * `import()` before a reader ever asks for it.
 */
export const LazyActivityFeed = lazy(() =>
  import("@/components/todo/activity-feed").then((m) => ({
    default: m.ActivityFeed,
  })),
);
