/**
 * Who owns `data-surface="todo"` on `documentElement`, and why it is
 * ref-counted rather than written by whoever happens to render last.
 *
 * `index.css`'s `[data-surface="todo"]` block is where every `--td-*` token
 * lives — Todoist's ground, its borders, the recognition chip's background,
 * every priority swatch (`task-priority-colors.ts` reads them by name). A
 * Todo surface rendered while that attribute is absent does not fall back to
 * something slightly off; it falls back to **nothing**, because an unresolved
 * `var(--td-…)` is an invalid value. Measured live on the device: on
 * `/composer`, `--td-recognition-background`, `--td-priority-picker-1` and
 * `--td-composer-background` all read `(UNSET)`.
 *
 * **Why `documentElement` and not a wrapper div.** `chat-shell-layout.tsx`
 * learned this the expensive way (its own header comment has the full trail):
 * the attribute began on the shell's div, which looked like the obvious
 * common ancestor, and it never reached a single overlay — Radix portals the
 * task detail dialog, the command menu, quick-find, the sheets, the confirm
 * dialogs and the scheduler popover into `document.body`, all *siblings* of
 * that div. `documentElement` is above every portal, which is the whole of
 * what makes the scope hold.
 *
 * **Why a ref count.** That placement leaves exactly one question: who decides
 * when it is on. It used to be one answer — the route (`/todo/*`) — and that
 * was wrong the moment a Todo surface learned to open somewhere else. The
 * Composer's Task detail overlay (ADR 0074's `onOpenTask`, `composer-page.tsx`)
 * is the real `TaskDetailView`, rendered over `/composer`, where the route test
 * says "not Todo" and strips the tokens out from under it. The reported
 * symptoms were a recognised date painting no chip and a priority picker whose
 * P1–P4 swatches all rendered grey — both are the same unresolved-token story,
 * not two bugs.
 *
 * Two independent owners (the route, and an overlay that can outlive a route
 * change) means a plain set/delete pair races: whichever unmounts last wins and
 * deletes an attribute the other still needs. Counting is what makes the
 * attribute present while *any* claim is held and absent only when the last one
 * is released, and it is why this lives in one module instead of being
 * open-coded per caller — a second hand-rolled effect is precisely how the two
 * would start disagreeing again.
 */
import { useEffect } from "react";

let claims = 0;

/**
 * Claims the Todo token scope for as long as `active` is true and the calling
 * component is mounted. Safe to hold from several places at once.
 *
 * Not a plain boolean prop on some provider: the claims that matter are held by
 * components on opposite sides of the route tree (a layout that knows the
 * pathname, and a page that knows whether its overlay is open), and neither is
 * an ancestor of the other.
 */
export function useTodoSurface(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    claims += 1;
    document.documentElement.dataset.surface = "todo";
    return () => {
      claims -= 1;
      if (claims <= 0) {
        claims = 0;
        // Removed rather than set to `""`: `[data-surface="todo"]` would not
        // match an empty value anyway, but a stray empty attribute on the
        // document root is the kind of thing a later selector starts matching
        // by accident, and there is nothing to gain by leaving one behind.
        // (`chat-shell-layout.tsx`'s own note, kept with the behaviour.)
        delete document.documentElement.dataset.surface;
      }
    };
  }, [active]);
}

/** Test-only: drops any claim left behind by a previous test's unmount order. */
export function resetTodoSurfaceForTest(): void {
  claims = 0;
  delete document.documentElement.dataset.surface;
}
