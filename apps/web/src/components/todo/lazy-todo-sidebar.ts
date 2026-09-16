import { lazy } from "react";

/**
 * `todo-sidebar.tsx`'s own component, behind a lazy boundary — the
 * identical "keep it out of the eager chunk" move `lazy-activity-feed.ts`
 * and this directory's other lazy wrappers already make, moved here from
 * `chat-shell-layout.tsx` when the owner overruled ADR 0076: that file
 * rendered unconditionally on every route, `/` included, so a static
 * import there (or here, without this wrapper) would drag
 * `entry-store-layout.tsx` (`todo-sidebar.tsx`'s own header comment
 * explains why it needs that module) onto the cold-start path issue #150's
 * lazy boundary exists to keep clear, for a reader who may never open Todo
 * at all.
 *
 * Its one caller now is `todo-page.tsx`'s own second-column mount, gated on
 * `useTodoSidebarLayout()` — a `Suspense fallback={null}` there reuses
 * App.tsx's own reasoning for its outer boundary: every lazy chunk here
 * ships in the same install as the shell, so a frame or two of nothing
 * beats a flash of chrome nobody has time to read, and only ever matters on
 * the first `/todo/*` navigation past 1200px in a session — every
 * navigation after that hits an already-resolved module.
 */
export const LazyTodoSidebar = lazy(() =>
  import("@/components/todo/todo-sidebar").then((m) => ({ default: m.TodoSidebar })),
);
