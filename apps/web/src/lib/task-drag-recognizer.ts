/**
 * The vertical drag recogniser for Inbox's row reorder — pointer geometry
 * and arithmetic, nothing else, the same split `swipe-recognizer.ts` draws
 * for the horizontal swipe. It answers exactly one question: given the rows
 * a dragged Task could land among and where the pointer is right now, which
 * position is that? It never touches the DOM, never calls `reorderTask`,
 * and never knows a Task exists — `todo-page.tsx` measures the rows, tracks
 * the pointer, and turns a "moved" verdict into the one `reorderedTaskOrderKey`
 * call ADR 0050 requires. That split is what makes this function directly
 * testable at exact coordinates, the same reason `swipe-recognizer.ts` is
 * pulled out of `use-swipe-actions.ts`.
 */

export interface RowRect {
  /** Client-space y of the row's top edge, in CSS pixels. */
  top: number;
  /** Client-space y of the row's bottom edge, in CSS pixels. */
  bottom: number;
}

export type DropVerdict =
  | {
      /**
       * The pointer names the exact slot the dragged Task already
       * occupies. Releasing here must write nothing at all — not a key
       * that happens to compute to the same place, which is why this is
       * its own verdict rather than something the caller has to notice by
       * comparing two indices after the fact.
       */
      kind: "unchanged";
    }
  | {
      kind: "moved";
      /**
       * A position in `reorderedTaskOrderKey`'s own `withoutDragged` space:
       * the dragged Task lands directly before `rows[dropIndex]`, or after
       * everything when `dropIndex === rows.length`. Passing this straight
       * through to that function is the whole point of measuring it this
       * way rather than as a row id — there is nothing left to translate.
       */
      dropIndex: number;
    };

/**
 * `rows` are every OTHER row currently on screen, top to bottom, with the
 * dragged row itself already excluded by the caller — it is not a valid
 * target for itself, and excluding it here rather than skipping it during
 * the scan is what keeps this function's output plug directly into
 * `reorderedTaskOrderKey`'s own `withoutDragged` indexing without a second
 * translation step.
 *
 * A row's own vertical midpoint is the boundary: the pointer in a row's top
 * half names the index before it; its bottom half, or anywhere past the
 * last row altogether, names the index after. That single rule is what
 * lets the trailing append zone `todo-page.tsx` draws below the last row
 * fall out for free — there is no separate rect for it to hit-test against,
 * "past every midpoint" already means "the end."
 *
 * `originalIndex` is where the dragged Task would have to land to
 * reconstruct its own current spot: its own index in the full,
 * un-filtered list. Removing one earlier item from a list never shifts
 * what comes after it, so the dragged Task's own index there and the drop
 * index that puts it straight back between the same two neighbours are
 * always the same number — no separate bookkeeping is needed to know when
 * a release is a no-op.
 */
export function dropIndexForPointer(
  rows: readonly RowRect[],
  pointerY: number,
  originalIndex: number,
): DropVerdict {
  let dropIndex = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const midpoint = (row.top + row.bottom) / 2;
    if (pointerY < midpoint) {
      dropIndex = i;
      break;
    }
  }
  return dropIndex === originalIndex ? { kind: "unchanged" } : { kind: "moved", dropIndex };
}
