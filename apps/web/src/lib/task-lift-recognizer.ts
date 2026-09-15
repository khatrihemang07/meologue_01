/**
 * Whether movement disqualifies a long-press-to-lift candidate (issue
 * #308) before its own timer ever fires — pointer geometry and
 * arithmetic, nothing else, the same split `swipe-recognizer.ts` draws
 * for the horizontal swipe.
 *
 * This module owns no timer of its own, unlike that one: "held still for
 * `LONG_PRESS_MS`" is a real elapsed-time question a `setTimeout` answers
 * at the call site (`task-row.tsx`), not something a pure function can
 * decide by itself — a perfectly still hold produces no `pointermove` at
 * all for this function to be called with, so ARMING has to be driven by
 * an actual timer, not by re-evaluating samples the way
 * `swipe-recognizer.ts`'s own `LONG_PRESS_MS` bail-out does (that one only
 * ever needs to *abandon*, which a stalled, event-driven check is enough
 * for — nothing has to happen on a hold with no events at all). What IS
 * decidable from geometry alone, and therefore lives here, is the other
 * half of the three-way race a pointerdown on a Task row's own body now
 * runs: does THIS movement already read as the vertical scroll, or the
 * horizontal swipe-to-schedule (`use-swipe-actions.ts`), that the same
 * pointerdown is also a candidate for?
 *
 * Deliberately reuses `swipe-recognizer.ts`'s own thresholds rather than
 * redefining them — not an approximation of that shape, the literal same
 * numbers — so the two recognisers, independently reading the identical
 * pointer stream on the identical row, can never disagree about where
 * "still a hold" ends and "a gesture" begins.
 */
import { HORIZONTAL_THRESHOLD_PX, VERTICAL_BAIL_PX } from "./swipe-recognizer";

/**
 * `dx`/`dy` are travel in CSS px from the press's own start point, in
 * either direction — this function doesn't care about the *sign* the way
 * `swipe-recognizer.ts`'s own leftward-only confirm rule does, only about
 * whether the hold is still one at all.
 *
 * True once travel reads as EITHER a vertical scroll or a horizontal
 * swipe candidate. Horizontal is checked in both directions, not only
 * leftward the way that module's own swipe-to-schedule confirms: a swipe
 * only ever opens on a leftward drag, but a rightward excursion just as
 * clearly isn't a still finger, and arming a lift out from under a
 * reader's hand mid-shrug is worse than declining to. `>` on both
 * comparisons, not `>=`: a press that lands exactly on either threshold
 * hasn't yet gone past it, the same boundary `swipe-recognizer.ts`'s own
 * `VERTICAL_BAIL_PX` check draws.
 */
export function liftCandidateBailed(dx: number, dy: number): boolean {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (ady > VERTICAL_BAIL_PX && ady > adx) return true;
  if (adx > HORIZONTAL_THRESHOLD_PX && adx > ady) return true;
  return false;
}
