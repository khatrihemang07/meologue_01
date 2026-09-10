import { lazy } from "react";

/**
 * `task-description-editor.tsx`'s own component, behind a lazy boundary —
 * the identical pattern `lazy-task-title-editor.ts` already establishes
 * for keeping ProseMirror out of `task-detail-view.tsx`'s own eager render
 * path (that file's own header comment has the general reasoning and the
 * bundle numbers this ticket's own budget is measured against). Rendered
 * only once the combined title/description edit form (DET-09) is open,
 * inside a `<Suspense>`, exactly like `LazyTaskTitleEditor`.
 */
export const LazyTaskDescriptionEditor = lazy(() =>
  import("@/components/todo/task-description-editor").then((m) => ({
    default: m.TaskDescriptionEditor,
  })),
);
