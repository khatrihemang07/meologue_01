/**
 * Puts keyboard focus back on a Task's own drag handle after a reparent
 * has moved that Task somewhere else in the tree.
 *
 * Why this is needed at all, and only for reparenting: a keyboard
 * *reorder* (`ArrowUp`/`ArrowDown` in task-tree.tsx) moves a row among its
 * existing siblings, so React keeps the same DOM node and focus simply
 * rides along — verified on the built app, where holding ArrowUp walks a
 * row up the list with focus intact the whole way. A *reparent*
 * (`Alt+ArrowRight`/`Alt+ArrowLeft`) moves the row into a different
 * `<ul>` — a different `TaskTree` instance entirely — so React unmounts
 * the old node and mounts a fresh one. The focused element ceases to
 * exist, and the browser's own fallback is to drop focus to `<body>`.
 *
 * That was not a theoretical concern. On the built app, focus after one
 * indent went to `BODY`, which meant keyboard reparenting worked exactly
 * once: a second `Alt+ArrowRight` went nowhere, and restructuring a list
 * meant re-finding and re-focusing a handle by hand between every single
 * step. An affordance that exists specifically so the tree can be
 * restructured without a pointer cannot require a pointer between moves.
 *
 * The retry loop is the awkward part and it is deliberate. The mutation
 * resolves, then TanStack Query refetches, then React re-renders — none
 * of which this function is a party to, and no single `requestAnimationFrame`
 * reliably lands after all three. Rather than reach into that pipeline and
 * couple this to how the data layer happens to be wired today, it polls
 * for the node it wants across a small number of frames and gives up
 * quietly. Giving up quietly is the right failure: the Task did move (the
 * write already succeeded), so the worst case is the focus loss this
 * function exists to prevent — exactly where the code was before it — and
 * never a thrown error over something purely cosmetic.
 */

/**
 * How many animation frames to keep looking for the moved row before
 * giving up. Eight is generous for a local SQLite write plus a re-render
 * (~130ms at 60Hz) and still short enough that a genuinely absent row —
 * one that moved into a collapsed branch, or a view the reader navigated
 * away from mid-keystroke — stops costing frames almost immediately.
 */
const MAX_FRAMES = 8;

/**
 * Focuses the drag handle inside the row for `taskId`, once it exists.
 *
 * The selector pairs `[data-task-id]` (task-row.tsx's own row attribute)
 * with `[data-testid="task-drag-handle"]` — the same handle every drag
 * and every keyboard gesture already starts from, so focus lands back on
 * the control the reader was actually using rather than on the row, the
 * checkbox, or some other plausible-looking target.
 */
export function refocusTaskHandle(taskId: string): void {
  if (typeof requestAnimationFrame !== "function") {
    // jsdom and any non-browser caller: nothing to focus into, and a
    // missing rAF is not worth a polyfill for an affordance that only
    // exists on screen.
    return;
  }
  let framesLeft = MAX_FRAMES;
  const attempt = () => {
    const selector = `[data-task-id="${CSS.escape(taskId)}"] [data-testid="task-drag-handle"]`;
    const handle = document.querySelector<HTMLElement>(selector);
    if (handle !== null) {
      handle.focus();
      return;
    }
    framesLeft -= 1;
    if (framesLeft > 0) {
      requestAnimationFrame(attempt);
    }
  };
  requestAnimationFrame(attempt);
}
