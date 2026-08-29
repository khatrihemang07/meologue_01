import { useCallback, useEffect, useRef } from "react";
import { useSettingsStore } from "@/lib/settings";

/** Matches the clamp `chat-shell-layout.tsx` applies to the rendered width. */
export const MIN_LIST_WIDTH = 260;
export const MAX_LIST_WIDTH = 560;
/** How much window has to be left for the open destination beside the list. */
export const MIN_PANE_WIDTH = 360;

/** One arrow press; Shift multiplies it, matching a text caret's word jump. */
const STEP_PX = 16;
const COARSE_STEP_PX = 64;

/**
 * The largest the list may be given the window it is in — the same bound
 * `chat-shell-layout.tsx` renders with, exported so the drag and the keyboard
 * steps below stop where the layout would have clamped them anyway rather
 * than letting a reader drag into a range that snaps back on release.
 */
export function maxListWidth(windowWidth: number): number {
  return Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, windowWidth - MIN_PANE_WIDTH));
}

export function clampListWidth(width: number, windowWidth: number): number {
  return Math.min(Math.max(width, MIN_LIST_WIDTH), maxListWidth(windowWidth));
}

/**
 * The handle between the chat list and the open destination (ADR 0036).
 *
 * Draggable and persisted on every platform, Android included — a tablet in
 * landscape is as much a two-pane window as a laptop is, and a handle that
 * ignores a finger is worse than no handle at all.
 *
 * `touch-action: none` is what makes the finger case work: without it
 * Chromium's own scroll gesture recognizer claims the drag before any
 * pointer handler sees the second move, and the divider simply never moves
 * on a touchscreen. It is the deliberate opposite of the thread's own
 * `pan-y`, which exists so a bubble stays scrollable and selectable under a
 * finger.
 *
 * Pointer capture rather than window-level listeners: a drag that leaves the
 * 8px-wide handle — which every drag does immediately — keeps delivering to
 * it, and the browser cleans the capture up on its own if the pointer is
 * cancelled by a system gesture.
 */
export function PaneDivider() {
  const listWidth = useSettingsStore((state) => state.listWidth);
  const setListWidth = useSettingsStore((state) => state.setListWidth);
  const dragging = useRef(false);

  const commit = useCallback(
    (width: number) => setListWidth(clampListWidth(width, window.innerWidth)),
    [setListWidth],
  );

  // Re-clamp when the window itself changes: a stored width that was legal
  // on a laptop leaves no room for the destination once the window is
  // dragged narrow, and the layout would otherwise render a list wider than
  // the bound while storage still claimed the old number.
  useEffect(() => {
    const onResize = () => {
      const clamped = clampListWidth(useSettingsStore.getState().listWidth, window.innerWidth);
      if (clamped !== useSettingsStore.getState().listWidth) setListWidth(clamped);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setListWidth]);

  return (
    // An `<hr>`, not a `<div role="separator"`: the separator role is this
    // element's implicit one, and a focusable separator carrying
    // `aria-valuenow` is exactly the window-splitter pattern. `m-0 border-0`
    // resets the UA's own rule so the border below is the only one drawn.
    <hr
      aria-orientation="vertical"
      aria-label="Resize the conversation list"
      aria-valuenow={Math.round(listWidth)}
      aria-valuemin={MIN_LIST_WIDTH}
      aria-valuemax={maxListWidth(typeof window === "undefined" ? 0 : window.innerWidth)}
      tabIndex={0}
      data-testid="pane-divider"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        // The pointer's own x IS the new boundary — the list starts at the
        // window's left edge, so no offset from where the drag began is
        // needed and the handle cannot drift away from the finger.
        commit(event.clientX);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? COARSE_STEP_PX : STEP_PX;
        if (event.key === "ArrowLeft") commit(listWidth - step);
        else if (event.key === "ArrowRight") commit(listWidth + step);
        else if (event.key === "Home") commit(MIN_LIST_WIDTH);
        else if (event.key === "End") commit(maxListWidth(window.innerWidth));
        else return;
        event.preventDefault();
      }}
      // A 1px line that takes an 8px-wide target: the visible rule is the
      // border, the padding around it is what a finger actually lands on.
      className="m-0 h-auto w-2 shrink-0 cursor-col-resize touch-none border-0 border-border border-r bg-background focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    />
  );
}
