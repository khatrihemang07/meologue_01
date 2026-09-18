import { lazy } from "react";

export const LazyTaskDescriptionEditor = lazy(() =>
  import("@/components/todo/task-description-editor").then((m) => ({
    default: m.TaskDescriptionEditor,
  })),
);
