import { useEffect, useState } from "react";

/**
 * The window width at which the chat list stops being a screen you navigate
 * away from and becomes a pane beside the one you opened (ADR 0036). Below
 * this, exactly one pane is ever on screen.
 */
export const WIDE_LAYOUT_QUERY = "(min-width: 900px)";

function matches(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(WIDE_LAYOUT_QUERY).matches;
}

/**
 * Whether the two-pane layout applies.
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
export function useWideLayout(): boolean {
  const [wide, setWide] = useState(matches);

  useEffect(() => {
    let cancelled = false;

    // Two frames, not one: the first still reports the pre-settle viewport
    // on a cold landscape launch. Cheap enough to pay unconditionally rather
    // than trying to detect the case it exists for.
    const outer = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(() => {
        if (!cancelled) setWide(matches());
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

    const query = window.matchMedia(WIDE_LAYOUT_QUERY);
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    query.addEventListener("change", onChange);

    return () => {
      cancelled = true;
      for (const frame of frames) cancelAnimationFrame(frame);
      query.removeEventListener("change", onChange);
    };
  }, []);

  return wide;
}
