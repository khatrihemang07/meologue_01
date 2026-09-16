import { useEffect, useState } from "react";

/**
 * The window width at which the chat list stops being a screen you navigate
 * away from and becomes a pane beside the one you opened (ADR 0036). Below
 * this, exactly one pane is ever on screen.
 */
export const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

/**
 * The window width at which Todo's own sidebar becomes a second column
 * beside the chat list pane (the owner's amendment to ADR 0076 —
 * `todo-page.tsx`'s own header comment on `TodoSidebar` has the current
 * decision). Between `WIDE_LAYOUT_QUERY` and this, Todo falls back to
 * `TodoNav`'s bottom bar instead: two persistent columns to Todo's content
 * left of it don't fit until there is enough window for both.
 */
export const TODO_SIDEBAR_QUERY = "(min-width: 1200px)";

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/**
 * Shared body behind `useWideLayout`/`useTodoSidebarLayout` — one
 * parameterised hook rather than two copies of the same effect, matching
 * every media query this file exports against the identical cold-launch
 * guard below.
 *
 * Deliberately JS-maintained rather than left to a bare `@media` block. A
 * synchronous `matchMedia` read at boot answers wrong on a cold launch that
 * is already in landscape: the WebView has not settled its own viewport yet
 * and reports the portrait width for the first frame or two. CSS alone would
 * recover silently, but anything keyed off this value in JS — which pane to
 * render at all — would have already made its decision on the wrong answer.
 *
 * So the value is re-asked on a double `requestAnimationFrame`, which is the
 * earliest point the viewport has settled, and then kept live by the query's
 * own `change` event for the rest of the session.
 */
function useMediaQueryLayout(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));

  useEffect(() => {
    let cancelled = false;

    // Two frames, not one: the first still reports the pre-settle viewport
    // on a cold landscape launch. Cheap enough to pay unconditionally rather
    // than trying to detect the case it exists for.
    const outer = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(() => {
        if (!cancelled) setValue(matches(query));
      });
      frames.push(inner);
    });
    const frames: number[] = [outer];

    if (typeof window.matchMedia !== "function") {
      return () => {
        cancelled = true;
        for (const frame of frames) cancelAnimationFrame(frame);
      };
    }

    const mediaQueryList = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setValue(event.matches);
    mediaQueryList.addEventListener("change", onChange);

    return () => {
      cancelled = true;
      for (const frame of frames) cancelAnimationFrame(frame);
      mediaQueryList.removeEventListener("change", onChange);
    };
  }, [query]);

  return value;
}

/** Whether the two-pane layout applies. */
export function useWideLayout(): boolean {
  return useMediaQueryLayout(WIDE_LAYOUT_QUERY);
}

/** Whether Todo's own sidebar renders as a second column. */
export function useTodoSidebarLayout(): boolean {
  return useMediaQueryLayout(TODO_SIDEBAR_QUERY);
}
