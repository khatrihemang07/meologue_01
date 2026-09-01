/**
 * The vertical drag recogniser for Inbox's row reorder **and reparent**
 * (issue #171) — pointer geometry and arithmetic, nothing else, the same
 * split `swipe-recognizer.ts` draws for the horizontal swipe. It answers
 * exactly one question: given the rows a dragged Task could land among and
 * where the pointer is right now, which position — or, now, which parent —
 * is that? It never touches the DOM, never calls `reorderTask` or
 * `setTaskParent`, and never knows a Task exists — `task-tree.tsx` measures
 * the rows, tracks the pointer, and turns a verdict into either the one
 * `reorderedTaskOrderKey` call ADR 0050 requires or the identical
 * `setTaskParent` call the keyboard reparent path already makes. That split
 * is what makes this function directly testable at exact coordinates, the
 * same reason `swipe-recognizer.ts` is pulled out of `use-swipe-actions.ts`.
 */

export interface RowRect {
  /** Client-space y of the row's top edge, in CSS pixels. */
  top: number;
  /** Client-space y of the row's bottom edge, in CSS pixels. */
  bottom: number;
}

/**
 * The fraction of a row's own height, measured in from each edge, that
 * still reads as "reorder" once nesting is offered at all. A pointer
 * within this band of the top edge means "insert before this row"; within
 * this band of the bottom edge, "insert after"; the 1 − 2×this fraction
 * left in the middle is `"nest"`.
 *
 * A plain 50/50 split (the pre-#171 rule, still what `canNest === false`
 * below falls back to) has no room left for a third outcome once one is
 * needed — the whole row is already spoken for by "before" and "after."
 * Quarter/half/quarter is the smallest edge fraction that still reads as
 * "the same reorder affordance as before" rather than "a sliver you have
 * to aim for": Todoist's own drag-to-nest, and Workflowy/Notion's outliner
 * drags, all give the *nest* zone the majority of the row rather than
 * splitting evenly three ways, on the reasoning that reordering by one
 * slot is recoverable with a second nudge but a mis-nested Task is a
 * separate `setParent` call (and, per this ticket's own brief, a possible
 * refusal) to undo. A quarter of a row is small on a phone — see this
 * ticket's own report for what that means on a real touchscreen, which
 * this constant cannot itself prove.
 */
const REORDER_EDGE_FRACTION = 0.25;

export type DropVerdict =
  | {
      /**
       * The pointer names the exact slot the dragged Task already
       * occupies. Releasing here must write nothing at all — not a key
       * that happens to compute to the same place, which is why this is
       * its own verdict rather than something the caller has to notice by
       * comparing two indices after the fact. Never produced for a
       * `"nest"` verdict below: `rows` never includes the dragged Task
       * itself (the caller's own contract, unchanged by #171), so nesting
       * under any row in it is always a real change to the dragged Task's
       * `parentId` — there is no "already nested here" to reconstruct.
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
    }
  | {
      /**
       * The pointer is over `rows[index]`'s own middle band: releasing
       * here reparents the dragged Task under that row, not between it
       * and a neighbour. Named `index`, not `dropIndex`, on purpose — a
       * `"moved"` verdict's `dropIndex` names a *position between rows*
       * (`reorderedTaskOrderKey`'s own space); this names one specific
       * *row*, the new parent, and the caller's own `ids` array (parallel
       * to the `rows` it measured) is what turns it into that row's Task
       * id. It is never the caller's job to re-derive which row `index`
       * means from a position — that translation already happened here.
       */
      kind: "nest";
      index: number;
    };

/**
 * `rows` are every OTHER row currently on screen, top to bottom, with the
 * dragged row itself already excluded by the caller — it is not a valid
 * target for itself, and excluding it here rather than skipping it during
 * the scan is what keeps this function's output plug directly into
 * `reorderedTaskOrderKey`'s own `withoutDragged` indexing without a second
 * translation step, and (issue #171) is what makes every `"nest"` verdict
 * automatically a real reparent — see that verdict's own doc comment.
 *
 * `canNest` is the caller's own answer to a question this function
 * deliberately cannot answer itself: whether nesting *anything* under
 * *any* row on screen right now would even be legal. That is a Task-store
 * question — `MAX_TASK_NESTING_DEPTH` (`@meologue/core`) — and this module's
 * own header comment is explicit that it never knows a Task exists, so
 * `task-tree.tsx` decides it once, from the one number it already has
 * (this sibling group's own `depth`), and passes the answer in rather than
 * this function reaching for a store it has no handle to. Wiring it as a
 * parameter rather than filtering a `"nest"` verdict out afterwards is
 * deliberate too: with nesting off, every row falls back to the *original*
 * 50/50 edge split, not a diminished quarter/quarter split with a dead
 * band in the middle where a drop would otherwise do nothing — a sibling
 * group already at the nesting cap keeps exactly the reorder affordance it
 * had before this ticket, rather than a worse one.
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
  canNest: boolean,
): DropVerdict {
  let dropIndex = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;

    if (!canNest) {
      // The pre-#171 rule, verbatim: a row's own vertical midpoint is the
      // boundary between "before it" and "after it" (which, for every row
      // but the last, is the same boundary as "before the next one" —
      // that's what lets the trailing append zone `task-tree.tsx` draws
      // below the last row fall out for free, with no separate rect to
      // hit-test against).
      const midpoint = (row.top + row.bottom) / 2;
      if (pointerY < midpoint) {
        dropIndex = i;
        break;
      }
      continue;
    }

    const height = row.bottom - row.top;
    const edge = height * REORDER_EDGE_FRACTION;
    if (pointerY < row.top + edge) {
      dropIndex = i;
      break;
    }
    if (pointerY < row.bottom - edge) {
      return { kind: "nest", index: i };
    }
    // The bottom edge band: not yet resolved to "after this row" here,
    // because that is indistinguishable from "before the next one" — the
    // same boundary-sharing the `!canNest` branch above relies on.
    // Falling through to the next iteration (or, for the last row, to the
    // trailing `dropIndex = rows.length` default) is what resolves it.
  }
  return dropIndex === originalIndex ? { kind: "unchanged" } : { kind: "moved", dropIndex };
}
