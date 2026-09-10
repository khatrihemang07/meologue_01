import { lazy } from "react";

/**
 * `task-title-editor.tsx`'s own component, behind a lazy boundary — the
 * identical pattern `lazy-destructive-confirm-dialog.ts` already
 * establishes for keeping Radix's `Dialog` out of Settings' eager chunk,
 * applied here for the reason issue #225's own GitHub comment records:
 * Todo's route measured 81,251 gzip bytes against an 87,600 ceiling right
 * before this ticket — 6,349 bytes of headroom, nowhere near enough for
 * ProseMirror (`prosemirror-state`/`-view`/`-model`/`-keymap`/`-history`),
 * even though every one of those packages already ships in this app for
 * the Composer. `check-bundle-size.mjs` counts a **shared** chunk against
 * every route that touches it, so a static import of `task-title-editor`
 * from anywhere Todo's own route reaches would land that whole weight on
 * Todo's number in full, not amortised against the one Composer route
 * that already budgets for it.
 *
 * One shared lazy chunk, not one per caller: `task-row-content.tsx`'s
 * inline rename and `task-detail-view.tsx`'s title both import this exact
 * specifier, so Rollup places `task-title-editor.tsx` in exactly one lazy
 * chunk regardless of which surface a reader edits from first — the
 * identical reasoning `lazy-destructive-confirm-dialog.ts`'s own header
 * comment gives for Device Restore and Server Restore sharing one lazy
 * `DestructiveConfirmDialog`.
 *
 * **Not used by Quick Add (`add-task-form.tsx`).** Todoist's own reference
 * treats the composer's title as the identical component (DET-06), and
 * issue #225's brief names it as a third call site — but `add-task-form.tsx`
 * today has real, shipped, heavily-tested recognition highlighting (the
 * transparent-input-plus-backdrop technique `quick-add-highlight.ts`
 * drives) with no ProseMirror decoration plugin yet built to replace it —
 * that plugin is #226's own scope, deliberately excluded here. Swapping
 * Quick Add onto this editor now would delete that shipped highlighting
 * for the whole gap until #226 lands its replacement, which is a real
 * regression, not a neutral refactor. This ticket's own report names the
 * omission plainly; the two conversions (swap the input, land the
 * decoration plugin that restores highlighting) belong in the same
 * change, most naturally #226 itself.
 *
 * Each caller renders this only once its own "is this title being edited
 * right now" state turns true, inside a `<Suspense>` — mounting it
 * unconditionally, even hidden, would trigger this `import()` on every
 * Todo visit and defeat the point, the same caution
 * `lazy-destructive-confirm-dialog.ts`'s own header comment states for its
 * `restoreDialogSummoned`-shaped flag.
 */
export const LazyTaskTitleEditor = lazy(() =>
  import("@/components/todo/task-title-editor").then((m) => ({
    default: m.TaskTitleEditor,
  })),
);
