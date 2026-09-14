/**
 * A `<textarea>` that grows with what is typed into it, up to a cap, and
 * scrolls internally only after that.
 *
 * Written for the Task detail view's two comment textareas (issue #180's
 * composer and `CommentRow`'s edit-in-place field), which were both fixed at
 * their `rows` attribute and could not be dragged bigger either — they carry
 * `resize: none`, the app's own convention for a field it lays out itself.
 *
 * **The defect this closes, measured on the device rather than reasoned about.**
 * The composer sat at **37.4px** whether it was empty, holding ~500 characters,
 * or holding ~2000 — while `scrollHeight` for those same contents read 276px
 * and 1016px. A long comment was being written into a one-line slot showing
 * roughly a twenty-seventh of itself, with no way to enlarge it. Todoist's own
 * comment editor is a contenteditable rich editor, so it grows with its content
 * the way every other block editor in this app already does; this is what gives
 * a plain `<textarea>` the same behaviour without swapping the whole control.
 *
 * **Why `height = "auto"` first.** `scrollHeight` on a textarea reports the
 * content height *or* the current box height, whichever is larger — so
 * measuring without collapsing first makes the box a ratchet that can grow and
 * never shrink again. Deleting a paragraph would leave the hole behind. The
 * reset is what makes this work in both directions.
 *
 * **Why a layout effect and not an `onChange` handler.** The value can change
 * without a keystroke — a cleared field after submit, a seeded edit, a paste, a
 * programmatic set — and every one of those needs the same remeasure. Running
 * on the value rather than on the event covers all of them; running *before*
 * paint is what stops the wrong height being shown for a frame.
 */
import { type RefObject, useLayoutEffect } from "react";

export interface AutoGrowOptions {
  /**
   * Tallest the field may grow before it starts scrolling inside itself, in
   * px. Required rather than defaulted: the right cap is a property of the
   * surface (how much room it has, and what it sits above), and a default here
   * would be a number nobody chose.
   */
  maxHeight: number;
}

/**
 * Keeps `ref`'s textarea sized to `value`, capped at `options.maxHeight`.
 *
 * Takes the value rather than reading it off the node so the effect re-runs
 * when React changes it — a ref alone gives this hook nothing to depend on, and
 * it would silently stop tracking the moment the value changed from anywhere
 * but a keystroke.
 */
export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: AutoGrowOptions,
): void {
  const { maxHeight } = options;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger, not an input — the effect measures the DOM node rather than reading the string, so the rule sees it as unused. Dropping it is what would break this: the node's height must be recomputed whenever React has put different text in it, including changes that arrive from somewhere other than a keystroke (a field cleared after submit, an edit seeded with an existing comment, a paste).
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) {
      return;
    }
    // Collapse before measuring — see this module's own header for why
    // skipping this turns the field into a one-way ratchet.
    node.style.height = "auto";
    const needed = node.scrollHeight;
    if (needed <= 0) {
      // Nothing laid out to measure: the field is display:none (a collapsed
      // section, a closed dialog), or this is jsdom, which reports 0 for every
      // layout read. Writing `0px` here would pin the field shut and leave it
      // that way until the value next changed — so leave the height alone and
      // let the next run, once there is a box, size it.
      node.style.height = "";
      return;
    }
    node.style.height = `${Math.min(needed, maxHeight)}px`;
    // Only scroll once the cap is actually reached. Leaving `overflow-y: auto`
    // on at all times makes some platforms reserve gutter space in a field
    // that has nothing to scroll.
    node.style.overflowY = needed > maxHeight ? "auto" : "hidden";
  }, [ref, value, maxHeight]);
}
