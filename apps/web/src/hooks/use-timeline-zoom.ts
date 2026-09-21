import type React from "react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryScrollContext } from "@/components/shell";
import { anchoredScrollTop, DEFAULT_ZOOM_INDEX, ZOOM_LEVELS, zoomLevelAt } from "@/lib/time-zoom";

/**
 * Owns Time's zoom level and every gesture that changes it (issue #418).
 *
 * The hard part is not the zoom index — it is keeping the instant a reader
 * was actually looking at under their cursor or finger while the scale's
 * height changes underneath it, which is what `time-zoom.ts`'s
 * `anchoredScrollTop` computes and this hook is responsible for applying at
 * the right moment: AFTER the new height has actually rendered
 * (`useLayoutEffect`, not `useEffect` — applying it a frame late would paint
 * one visible jump before correcting itself).
 *
 * The vertical scroller this hook adjusts is `Shell`'s own scroll region,
 * reached through `HistoryScrollContext`'s `scrollElement` — Shell owns the
 * *only* vertical scroll element on the page (that context's own header
 * comment), so Time must not stand up a second `overflow-y-auto` of its own
 * the way an ordinary "just wrap it in a scrollable div" implementation
 * would.
 *
 * Three gestures, one underlying step function (`requestZoom`):
 * ctrl/⌘+wheel (a trackpad pinch is delivered to the browser as a wheel
 * event with `ctrlKey: true`, indistinguishable from an actual held-down
 * Ctrl at this API), two-finger touch pinch via pointer events, and
 * `+`/`=`/`-` while the timeline has focus. The wheel listener is attached by
 * hand with `{ passive: false }` rather than through JSX `onWheel`: React
 * attaches `wheel` (and `touchstart`/`touchmove`) at the root as passive by
 * default for scroll-performance reasons, which makes `preventDefault()` a
 * silent no-op — exactly the trap that would leave the *page* zooming
 * instead of the timeline.
 */

/** How much closer/further two touch points must get to register one zoom step, rebased after each step so a single long pinch can walk several levels. */
const PINCH_STEP_RATIO = 1.15;

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface UseTimelineZoomResult {
  pxPerHour: number;
  zoomIndex: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  /**
   * Attach to the element wrapping the gutter and every lane. Measured for
   * the scroll-anchoring math (its offset within the scroller decides
   * `timelineTop`) and is where the wheel listener attaches.
   */
  timelineRef: React.RefCallback<HTMLDivElement>;
  /**
   * Spread onto the same element `timelineRef` is attached to. `tabIndex`
   * makes it a legal target for the keyboard shortcut; `touchAction` is what
   * stops the browser's own page-zoom from claiming a two-finger pinch
   * before `onPointerMove` ever sees it move.
   */
  timelineProps: {
    tabIndex: number;
    style: React.CSSProperties;
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerCancel: (event: React.PointerEvent) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
  };
}

export function useTimelineZoom(): UseTimelineZoomResult {
  const { scrollElement } = useContext(HistoryScrollContext);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const pxPerHour = zoomLevelAt(zoomIndex);

  // A ref mirror of `zoomIndex`, the same pattern `time-page.tsx`'s own
  // `wasRunning` ref uses: the wheel, pointer and keyboard listeners below
  // are native/imperative and must not close over a stale index from
  // whichever render first attached them.
  const zoomIndexRef = useRef(zoomIndex);
  useEffect(() => {
    zoomIndexRef.current = zoomIndex;
  }, [zoomIndex]);

  // State, not a ref object: the page mounts this hook before a day's lanes
  // have loaded, and only then draws the timeline. A ref object's change
  // re-runs nothing, so the wheel listener below would never attach to a
  // timeline that appeared later — ctrl+wheel and trackpad pinch were dead on
  // every first load until this was a callback ref feeding state.
  const [timelineNode, setTimelineNode] = useState<HTMLDivElement | null>(null);
  const timelineRef = useCallback((node: HTMLDivElement | null) => setTimelineNode(node), []);

  // What `anchoredScrollTop` needs, captured at the *moment a gesture asks
  // to zoom* rather than re-read once the layout effect below actually
  // runs — `scrollTop` in particular can be silently clamped by the browser
  // the instant the content shrinks, so reading it late would anchor against
  // an already-corrected value instead of the one the gesture actually saw.
  const pendingAnchorRef = useRef<{
    focalOffset: number;
    oldPxPerHour: number;
    scrollTop: number;
  } | null>(null);

  const requestZoom = useCallback(
    (nextIndex: number, focalOffset: number) => {
      const clamped = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, nextIndex));
      if (clamped === zoomIndexRef.current) {
        return;
      }
      pendingAnchorRef.current = {
        focalOffset,
        oldPxPerHour: zoomLevelAt(zoomIndexRef.current),
        scrollTop: scrollElement?.scrollTop ?? 0,
      };
      setZoomIndex(clamped);
    },
    [scrollElement],
  );

  // Applied once the new scale has actually rendered — `useLayoutEffect` so
  // the anchored position paints in the same frame as the new height, never
  // a frame late (which would show a visible jump-then-correct).
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    if (!pending || !scrollElement || !timelineNode) {
      return;
    }
    const scrollerRect = scrollElement.getBoundingClientRect();
    // Measures the scale itself (`comparative-timeline.tsx`'s `ScaleGutter`
    // marks its scale div `data-time-scale`), not the timeline wrapper this
    // ref is attached to — the wrapper also contains the (possibly sticky)
    // `LaneHeading`, which sits one heading's height ABOVE where the scale,
    // and so every record, actually starts. Using the wrapper's own top
    // drifted the zoom anchor by exactly that height on every step,
    // compounding over repeated zooms (~20px, ~5 minutes at 120px/hour,
    // measured). Falls back to the wrapper itself when no such element
    // exists, which is every test harness in this file that doesn't
    // construct one on purpose.
    const scaleNode = timelineNode.querySelector<HTMLElement>("[data-time-scale]") ?? timelineNode;
    const timelineRect = scaleNode.getBoundingClientRect();
    const timelineTop = timelineRect.top - scrollerRect.top + scrollElement.scrollTop;
    scrollElement.scrollTop = anchoredScrollTop({
      scrollTop: pending.scrollTop,
      focalOffset: pending.focalOffset,
      timelineTop,
      oldPxPerHour: pending.oldPxPerHour,
      newPxPerHour: pxPerHour,
    });
    // Deliberately keyed on `pxPerHour`, not `zoomIndex` — they change
    // together, but the height this effect exists to react to is a function
    // of `pxPerHour`.
  }, [pxPerHour, scrollElement, timelineNode]);

  /** A button press has no cursor of its own; the visible middle of the scroller reads as the least surprising point to hold fixed. */
  const centerFocalOffset = useCallback(
    () => (scrollElement ? scrollElement.clientHeight / 2 : 0),
    [scrollElement],
  );

  const zoomIn = useCallback(
    () => requestZoom(zoomIndexRef.current + 1, centerFocalOffset()),
    [requestZoom, centerFocalOffset],
  );
  const zoomOut = useCallback(
    () => requestZoom(zoomIndexRef.current - 1, centerFocalOffset()),
    [requestZoom, centerFocalOffset],
  );
  const reset = useCallback(
    () => requestZoom(DEFAULT_ZOOM_INDEX, centerFocalOffset()),
    [requestZoom, centerFocalOffset],
  );

  // ctrl/⌘+wheel and trackpad pinch — see this file's own header comment for
  // why this is a hand-attached, non-passive listener rather than JSX
  // `onWheel`.
  useEffect(() => {
    const node = timelineNode;
    if (!node) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      const rect = scrollElement?.getBoundingClientRect();
      const focalOffset = rect ? event.clientY - rect.top : 0;
      const direction = event.deltaY < 0 ? 1 : -1;
      requestZoom(zoomIndexRef.current + direction, focalOffset);
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, [timelineNode, scrollElement, requestZoom]);

  // Two-finger touch pinch. Pointer events rather than `TouchEvent`: this
  // repo already prefers the unified pointer API elsewhere (`use-swipe-
  // actions.ts`), and it is what lets one finger's `pointerId` be told apart
  // from the other's across a whole gesture.
  const activePointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStartDistance = useRef<number | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.current.size === 2) {
      const [a, b] = [...activePointers.current.values()];
      // `size === 2` guarantees both exist; `noUncheckedIndexedAccess`
      // cannot see that from a `Map`'s iterator alone.
      if (a && b) {
        pinchStartDistance.current = distance(a, b);
      }
    }
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!activePointers.current.has(event.pointerId)) {
        return;
      }
      activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePointers.current.size !== 2 || pinchStartDistance.current === null) {
        return;
      }
      const [a, b] = [...activePointers.current.values()];
      // Same `size === 2` guarantee as `onPointerDown` above.
      if (!a || !b) {
        return;
      }
      const current = distance(a, b);
      const ratio = current / pinchStartDistance.current;
      if (ratio < PINCH_STEP_RATIO && ratio > 1 / PINCH_STEP_RATIO) {
        return;
      }
      const direction = ratio > 1 ? 1 : -1;
      const midpointY = (a.y + b.y) / 2;
      const rect = scrollElement?.getBoundingClientRect();
      const focalOffset = rect ? midpointY - rect.top : 0;
      requestZoom(zoomIndexRef.current + direction, focalOffset);
      // Rebased on the step just taken, not the gesture's original distance,
      // so a single long pinch keeps stepping instead of firing once.
      pinchStartDistance.current = current;
    },
    [scrollElement, requestZoom],
  );

  const clearPointer = useCallback((event: React.PointerEvent) => {
    activePointers.current.delete(event.pointerId);
    if (activePointers.current.size < 2) {
      pinchStartDistance.current = null;
    }
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        requestZoom(zoomIndexRef.current + 1, centerFocalOffset());
      } else if (event.key === "-") {
        event.preventDefault();
        requestZoom(zoomIndexRef.current - 1, centerFocalOffset());
      }
    },
    [requestZoom, centerFocalOffset],
  );

  return {
    pxPerHour,
    zoomIndex,
    canZoomIn: zoomIndex < ZOOM_LEVELS.length - 1,
    canZoomOut: zoomIndex > 0,
    zoomIn,
    zoomOut,
    reset,
    timelineRef,
    timelineProps: {
      tabIndex: 0,
      // `pan-x pan-y`, not `auto` or omitted: the default lets the browser
      // treat a two-finger pinch as a page-zoom gesture before this hook's
      // own `onPointerMove` ever sees the second pointer move.
      style: { touchAction: "pan-x pan-y" },
      onPointerDown,
      onPointerMove,
      onPointerUp: clearPointer,
      onPointerCancel: clearPointer,
      onKeyDown,
    },
  };
}
