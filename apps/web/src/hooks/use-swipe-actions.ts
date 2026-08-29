import { useCallback, useRef } from "react";
import { createSwipeRecognizer } from "@/lib/swipe-recognizer";

/**
 * What a leftward swipe MEANS, as opposed to `swipe-recognizer.ts`'s own
 * "what a swipe IS": one recogniser per scrolling region, the transform that
 * makes the gesture visible, and the spring back that always follows it.
 *
 * One recogniser for the whole thread, not one per bubble. A virtualised
 * History mounts and unmounts rows constantly; per-row listeners would be the
 * same per-row cost issue #78 removed, and a gesture that began on a row
 * scrolled out from under the finger would lose its own listener mid-drag.
 *
 * Nothing is revealed underneath the bubble, so nothing latches: a release
 * past the threshold springs the bubble straight back to zero while the sheet
 * slides up over it. That is the whole reason the sheet won this ticket —
 * actions kept inside the row are what forced the retired prototype to narrow
 * the bubble's max width by the revealed strip, which reflowed the text and
 * turned a one-line Entry into two the instant the row opened.
 *
 * The bubble moves by `transform` alone, which is a paint-time operation: its
 * width, its line breaks and every other row's position are arithmetically
 * incapable of changing while it does.
 */

/** Long enough to read as a spring, short enough not to delay the sheet. */
const SPRING_BACK_MS = 180;

const SPRING_BACK_EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";

/** Marks an element as something a swipe can pick up. */
export const SWIPE_TARGET_ATTRIBUTE = "data-swipe-target";

export interface SwipeActionsOptions {
  /**
   * Called once, on release, when the swipe travelled far enough or fast
   * enough. Receives the element that carries `data-swipe-target`, so the
   * caller resolves it back to whatever the row stands for rather than this
   * hook needing to know there are Entries at all.
   */
  onOpen: (target: HTMLElement) => void;
  /** False leaves the thread with no horizontal gesture wired at all. */
  enabled?: boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Returns the ref to put on the element the swipeable rows live inside.
 *
 * A REF CALLBACK, not an effect keyed on a `RefObject` the caller passes in.
 * A `useRef` is not a dependency that can change, so an effect keyed on one
 * runs exactly once — at first commit — and reads `.current` while it is
 * still null if the container mounts later. History is exactly that case:
 * its first render, with the Entry store still opening, returns "History
 * will appear here." and no row container at all, so every gesture on the
 * thread that followed was silently dead. jsdom never showed it, because
 * every unit test renders History with its Entries already in hand; it took
 * a real browser loading real Entries to see it. React calls a ref callback
 * with the node the moment it exists, whenever that is, and runs the cleanup
 * it returns when the node goes away.
 *
 * The callback is stable for the component's whole life, and everything that
 * varies between renders is read through a ref at the moment of a gesture
 * rather than closed over when the listeners go on. An unstable ref callback
 * would tear the listeners down and put them back on every render, which on
 * a thread that re-renders per scroll frame is exactly the per-row cost this
 * hook's single recogniser exists to avoid. Holding the node in state would
 * cost a whole extra render of the thread on mount, for the same reason.
 */
export function useSwipeActions({ onOpen, enabled = true }: SwipeActionsOptions) {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  // Read at pointerdown rather than when the listeners go on, so turning the
  // gesture off takes effect without detaching anything.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  return useCallback((container: HTMLElement | null) => {
    if (!container) return;

    // The element currently under the finger, and whose transform is
    // therefore this hook's to write and to clean up.
    let target: HTMLElement | null = null;
    // Whether anything was actually written to it. A tap and a vertical
    // scroll both end at a bubble that never moved, and springing those back
    // would write a `transition` onto a row the virtualiser may recycle
    // within the animation's own duration — so an untouched bubble is left
    // untouched.
    let held = false;

    const recognizer = createSwipeRecognizer({
      isSelectionCollapsed: () => {
        const selection = window.getSelection();
        return !selection || selection.isCollapsed;
      },
    });

    const hold = (element: HTMLElement, offset: number) => {
      held = true;
      element.style.transition = "none";
      element.style.transform = `translateX(${offset}px)`;
    };

    const release = (element: HTMLElement) => {
      if (prefersReducedMotion()) {
        element.style.transition = "";
        element.style.transform = "";
        return;
      }
      element.style.transition = `transform ${SPRING_BACK_MS}ms ${SPRING_BACK_EASING}`;
      element.style.transform = "translateX(0px)";
      // Cleared rather than left behind: an inline `transition` on a row the
      // virtualiser later recycles for a different Entry would animate that
      // Entry's arrival. `transitionend` alone is not enough — it never fires
      // when the bubble was already at zero — so the timer is the one that
      // has to be authoritative, and the listener only exists to tidy up
      // early.
      const clear = () => {
        element.style.transition = "";
        element.style.transform = "";
        element.removeEventListener("transitionend", clear);
      };
      element.addEventListener("transitionend", clear);
      window.setTimeout(clear, SPRING_BACK_MS + 50);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!enabledRef.current) return;
      // Touch and pen only. A mouse drag across an Entry is a text selection,
      // which is exactly what issue #78 restored by deleting the per-row
      // ContextMenu, and a recogniser that confirmed on 12px of leftward
      // mouse travel would take it away again. A mouse reaches Edit, Copy
      // and Delete through the hover buttons and right-click instead.
      if (event.pointerType === "mouse") return;
      const found =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(`[${SWIPE_TARGET_ATTRIBUTE}]`)
          : null;
      if (!found || !container.contains(found)) return;
      const started = recognizer.down({
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        t: event.timeStamp,
      });
      if (started) {
        target = found;
        held = false;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (target === null) return;
      const result = recognizer.move({
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        t: event.timeStamp,
      });
      if (result.kind === "ignored") return;
      if (result.kind === "abandoned") {
        if (held) release(target);
        target = null;
        return;
      }
      if (result.justConfirmed) {
        try {
          container.setPointerCapture(event.pointerId);
        } catch {
          // The pointer can go away between the event firing and this call;
          // `pane-divider.tsx`'s drag hits the same case. Nothing to recover
          // — movement simply is not captured.
        }
      }
      // Only now, confirmed and moving, is the browser's own default action
      // suppressed. Never on pointerdown: at that moment this could still be
      // a swipe, a long-press-to-select or a scroll, and suppressing it there
      // would steal all three before the gesture had earned any of them.
      if (event.cancelable) event.preventDefault();
      hold(target, result.offset);
    };

    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (target === null) return;
      const element = target;
      const moved = held;
      target = null;
      try {
        container.releasePointerCapture(event.pointerId);
      } catch {
        // Already released, or capture never succeeded.
      }
      const result = cancelled
        ? ({ kind: "ignored" } as const)
        : recognizer.end({
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            t: event.timeStamp,
          });
      if (cancelled) recognizer.cancel();
      if (moved) release(element);
      if (result.kind === "released" && result.opens) {
        onOpenRef.current(element);
      }
    };

    const onPointerUp = (event: PointerEvent) => finish(event, false);
    const onPointerCancel = (event: PointerEvent) => finish(event, true);

    // Native listeners with `{ passive: false }`, not React's synthetic ones:
    // `preventDefault` above has to be honoured, and React attaches its own
    // listeners at the root with options this code does not control.
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove, { passive: false });
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerCancel);
    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerCancel);
      // A thread unmounted mid-drag would otherwise leave a bubble parked
      // off-centre in whatever the virtualiser recycles the node into.
      if (target && held) {
        target.style.transition = "";
        target.style.transform = "";
      }
      recognizer.cancel();
    };
  }, []);
}
