import { useEffect, useState } from "react";

/**
 * Whether `element`'s own `scrollTop` has reached `thresholdPx` — the
 * shared trigger behind issue #437's two scroll-linked Todo affordances:
 * Todoist web's mini "Today / N tasks" (34px) and the Overdue header's own
 * sticky hand-off (84px, though that one is really just where CSS
 * `position: sticky` naturally engages — see overdue-section-summary.tsx's
 * own comment). Both need the identical property this hook gives them:
 * INSTANT, no transition, a plain boolean tied to a scroll position rather
 * than an animated class.
 *
 * A passive `scroll` listener attached directly to `element`, not a
 * `ResizeObserver`/`IntersectionObserver` sentinel — this is one scalar
 * comparison against `scrollTop`, and a sentinel element would only
 * re-derive the identical answer at the cost of a real DOM node to mount,
 * position at the threshold, and keep in sync if the threshold ever
 * changed. `{ passive: true }` is load-bearing, not decorative: it tells
 * the browser this listener never calls `preventDefault()`, so scrolling
 * itself never blocks on this callback running first.
 *
 * `element === null` (Shell's own `scrollElement` before its ref has
 * attached, or any caller with no scroll region of its own to report)
 * reads as "not past the threshold" — the same answer a first paint at
 * `scrollTop === 0` already gives, so a caller never has to special-case
 * the mounting gap itself.
 */
export function useScrollThreshold(element: HTMLElement | null, thresholdPx: number): boolean {
  const [pastThreshold, setPastThreshold] = useState(
    () => (element?.scrollTop ?? 0) >= thresholdPx,
  );

  useEffect(() => {
    if (element === null) {
      setPastThreshold(false);
      return;
    }

    // `element` is narrowed non-null by the guard above, but the closure
    // below captures the outer (possibly-widened) binding — read through a
    // local so TypeScript keeps that narrowing inside the callback too.
    const target = element;
    function handleScroll() {
      setPastThreshold(target.scrollTop >= thresholdPx);
    }

    handleScroll();
    target.addEventListener("scroll", handleScroll, { passive: true });
    return () => target.removeEventListener("scroll", handleScroll);
  }, [element, thresholdPx]);

  return pastThreshold;
}
