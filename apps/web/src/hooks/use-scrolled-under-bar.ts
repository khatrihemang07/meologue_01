import { type RefObject, useEffect, useState } from "react";

/**
 * Whether `targetRef`'s own element has scrolled entirely under a sticky
 * bar `barHeightPx` tall, pinned to `scrollElement`'s own top edge — the
 * exact rule issue #437's own mini "Today / N tasks" needs: shown when the
 * real title's bottom edge is at or above the bar's bottom edge.
 *
 * This file replaces an earlier, fixed-pixel `useScrollThreshold(scrollTop
 * >= 34)`. Two real-browser findings killed that design, not just its
 * number:
 *
 * 1. **The number itself was never a constant.** A real-browser read of
 *    Todoist measured 34px when this ticket was written and 23px on a
 *    later re-check — the SAME rule, "the title has scrolled under the
 *    bar," expressed in Todoist's own layout on that particular day. A
 *    fixed pixel count bakes in one reading of a number that moves with
 *    page layout (font metrics, a locale's line count, a future redesign)
 *    — the geometry comparison below has no such constant to drift out of
 *    date, because it never hard-codes a scroll distance at all.
 * 2. **A `scroll`-event listener only ever samples `scrollTop` at whatever
 *    granularity the browser dispatches events, which under real
 *    momentum/fling scrolling is coarser and slower than a single-pixel
 *    threshold needs** — a fast scroll can step clean over a thin band
 *    (`...20, 38, 56...` skipping 34 outright), and each `setState` from
 *    that listener still has to clear a render+commit before it paints,
 *    adding a further, DIRECTIONAL lag in whichever way the reader was
 *    already travelling. Measured live: the mini title appeared at ~45px
 *    scrolling down and disappeared at ~27px scrolling up — an ~18px
 *    band, not a single crossing. `apps/web/src/hooks/use-scroll-
 *    threshold.test.ts`'s own unit tests never caught this: `fireEvent.
 *    scroll` dispatches one synchronous event with no frame timing at
 *    all, so the design's real weakness was invisible to jsdom. A single
 *    instantaneous jump (`scrollTop = 200` in one assignment, the exact
 *    shape a browser-automation driver uses) was also, separately,
 *    sometimes invisible: that design's ONLY chance to ever re-check
 *    position was a `scroll` event actually being dispatched for it, and
 *    that dispatch is not guaranteed to happen, or to happen before a
 *    driver's next assertion runs, for a single programmatic assignment.
 *
 * `IntersectionObserver` has neither problem. It is the browser's own
 * native geometry tracking, not a JS poll of a DOM event — it fires for
 * ANY change to the target's intersection with the (margin-adjusted) root,
 * however that change happened, including a single instantaneous jump, and
 * it needs no separate `resize` listener of its own: a resize that moves
 * the title relative to the bar IS a geometry change, which is exactly
 * what this observer already watches for.
 *
 * `rootMargin: "-{barHeightPx}px 0 0 0"` shrinks the observed root by the
 * bar's own height from the top, so the observer's boundary sits exactly
 * at the bar's bottom edge (the bar is `position: sticky; top: 0`, pinned
 * flush to `scrollElement`'s own top — its bottom edge is always
 * `scrollElement`'s top plus its own height). `threshold: 0` (the
 * default) means `entry.isIntersecting` is true the instant ANY pixel of
 * the title still overlaps that region — so `!entry.isIntersecting`
 * becomes true the instant the title has ENTIRELY left it, i.e. the
 * title's own bottom edge is now at or above the bar's bottom edge, which
 * is this hook's whole contract.
 */
export function useScrolledUnderBar(
  scrollElement: HTMLElement | null,
  targetRef: RefObject<HTMLElement | null>,
  barHeightPx: number,
): boolean {
  const [scrolledUnder, setScrolledUnder] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    // No scroll region yet, no title to observe, or (an old engine with
    // no `IntersectionObserver`) nothing capable of answering this —
    // reads as "not scrolled under," the same "absence of information
    // never turns the feature on" default `lib/pointer.ts`'s own
    // `touchOnlyDevice()` already uses.
    if (scrollElement === null || target === null || typeof IntersectionObserver !== "function") {
      setScrolledUnder(false);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry !== undefined) {
          setScrolledUnder(!entry.isIntersecting);
        }
      },
      { root: scrollElement, rootMargin: `-${barHeightPx}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollElement, targetRef, barHeightPx]);

  return scrolledUnder;
}
