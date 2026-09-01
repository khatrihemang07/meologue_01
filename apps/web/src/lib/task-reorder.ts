import type { Task } from "@meologue/core";
import { orderKeyBetween } from "@meologue/core";

/**
 * The one new `orderKey` a drop produces (ADR 0050) — the whole of what
 * Inbox's drag handling has to compute, and deliberately nothing more.
 *
 * `tasks` is the active list in its current (orderKey, id) order
 * (TaskStore.list()'s own guarantee), including `draggedId` wherever it
 * currently sits — this function doesn't need to know where that is, only
 * where it's landing. `dropIndex` is the position `draggedId` should occupy
 * once removed from its old spot and reinserted, indexed against the list
 * with `draggedId` already taken out (so the sibling that ends up directly
 * before the drop is `withoutDragged[dropIndex - 1]` and the one directly
 * after is `withoutDragged[dropIndex]`, never the dragged Task itself).
 *
 * This is a pure function precisely so it can be asserted directly: given a
 * list and a drop position, it returns a key strictly between the correct
 * two neighbours and touches nothing else — no store call, no Task object
 * mutated — which is what makes "dragging writes exactly one row" (this
 * ticket's own acceptance criterion, and ADR 0050's central claim) provable
 * here without a live TaskStore. The one row itself is written by whoever
 * calls `reorderTask(draggedId, key)` (use-tasks.ts) with this function's
 * result — nothing here writes anything.
 */
export function reorderedTaskOrderKey(tasks: Task[], draggedId: string, dropIndex: number): string {
  const withoutDragged = tasks.filter((task) => task.id !== draggedId);
  // Clamped rather than trusted: a drop index derived from pointer
  // coordinates can land at -1 (above the first row) or past the last row
  // depending on how the caller measures it, and orderKeyBetween's own
  // `null` bounds already mean "no neighbour on this side" — clamping here
  // is what lets a caller pass a raw, unchecked index without every call
  // site re-deriving the same bounds check.
  const clampedIndex = Math.max(0, Math.min(dropIndex, withoutDragged.length));
  const before = withoutDragged[clampedIndex - 1]?.orderKey ?? null;
  const after = withoutDragged[clampedIndex]?.orderKey ?? null;
  return orderKeyBetween(before, after);
}
