import { lazy } from "react";

/**
 * `task-detail-view.tsx`'s own component, behind a lazy boundary — the
 * identical "keep it out of the eager chunk" move `lazy-destructive-
 * confirm-dialog.ts` and `lazy-task-title-editor.ts` already make, applied
 * here because Todo's route ran out of room to make it: 86,949 gzip bytes
 * against an 87,600 ceiling, 651 bytes of headroom, with issue #228's
 * keyboard layer and issue #229's detail modal/project/label/filter
 * management both still landing on this route (this ticket's own brief).
 *
 * `TaskDetailView` is the single largest first-party module behind that
 * number (~36 KB of source) and, unlike `task-title-editor.tsx`, it was
 * never a shared dependency of multiple surfaces — `todo-page.tsx` is its
 * only caller (`grep`'s own answer to that question, this ticket's own
 * research) — so nothing is amortised by moving it; the whole weight
 * simply stops being paid on every Todo visit and starts being paid only
 * by the one address (`/todo/task/:taskSlugId`) that actually renders it.
 *
 * That gate is `todo-page.tsx`'s own `openTask !== null` check, unchanged
 * by this split: a reader browsing Inbox, Today, a Project or a Filter
 * never has `openTask` set, so the `import()` below never fires on first
 * paint of any of those views — exactly the boundary this repo's other
 * two lazy wrappers already draw at "renders only on request," not
 * "renders eventually."
 */
export const LazyTaskDetailView = lazy(() =>
  import("@/components/todo/task-detail-view").then((m) => ({
    default: m.TaskDetailView,
  })),
);
