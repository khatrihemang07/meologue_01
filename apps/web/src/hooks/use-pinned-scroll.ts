import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How close to the newest (bottom) edge counts as "at" it, in pixels.
 * `scrollHeight - scrollTop - clientHeight` is only ever exactly 0 after a
 * layout that lands on a whole pixel; a little slack keeps a
 * fractional-pixel remainder (subpixel rendering, a scrollbar rounding
 * error) from reading as "scrolled away" when the reader is, as far as
 * they can tell, at the bottom.
 */
const NEWEST_THRESHOLD_PX = 24;

export interface UsePinnedScrollOptions {
  /** Off entirely for pages with no pinned thread — Settings, plain History. */
  enabled: boolean;
  /**
   * Whatever value changes exactly when new content that might need
   * following has appeared — the caller's Entries array, typically. This
   * hook has no notion of "Entry" itself, on purpose (ticket 53: the pin is
   * a view-only concern, not a store one — see ADR 0014).
   */
  watch: unknown;
  /**
   * Bump this (e.g. a counter) whenever the reader takes an action that
   * must land at the newest end unconditionally, regardless of the current
   * pin state — ticket 53's "Sending an Entry always keeps the view at the
   * newest end." Every other value change here follows `watch`'s
   * conditional rule instead: it only moves the view if it was already
   * pinned.
   */
  forceToNewest?: unknown;
}

export interface UsePinnedScrollResult {
  /** Attach to the scrollable element. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the scrollable element's `onScroll`. */
  handleScroll: () => void;
  /** True once the view is away from the newest end — drives the jump-to-newest control's visibility. */
  awayFromNewest: boolean;
  /** Scrolls to the newest end and re-engages the pin. Wire to the jump-to-newest control. */
  jumpToNewest: () => void;
}

/**
 * Ticket 53's conditional pin: a thread reads oldest-to-newest and follows
 * newly-appeared content only while the reader is already at the newest
 * end. Scrolling away disengages the pin; scrolling back to the newest end,
 * or calling `jumpToNewest`, re-engages it.
 */
export function usePinnedScroll({
  enabled,
  watch,
  forceToNewest,
}: UsePinnedScrollOptions): UsePinnedScrollResult {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // A ref alongside the state: the effects below need the *current* pin
  // state synchronously (to decide whether to follow), not the value from
  // whatever render closed over them — state alone would only ever see the
  // value as of the last render.
  const pinnedRef = useRef(true);
  const [awayFromNewest, setAwayFromNewest] = useState(false);

  const isAtNewest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return true;
    }
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEWEST_THRESHOLD_PX;
  }, []);

  const scrollToNewest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setAwayFromNewest(!next);
  }, []);

  const jumpToNewest = useCallback(() => {
    scrollToNewest();
    setPinned(true);
  }, [scrollToNewest, setPinned]);

  // Scrolling disengages the pin the moment the reader leaves the newest
  // end, and re-engages it the moment they scroll back — the same check
  // both directions, driven by the element's own scroll position rather
  // than tracked some other way.
  const handleScroll = useCallback(() => {
    setPinned(isAtNewest());
  }, [isAtNewest, setPinned]);

  // The conditional follow: runs whenever `watch` changes (new content
  // appeared, from Send or Sync alike), but only actually moves the scroll
  // position if the reader was already pinned — an Entry arriving from
  // Sync while the reader has scrolled up must not yank them back down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` is deliberately the only content-driven dependency — it stands in for "new content appeared," not a value this effect reads.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (pinnedRef.current) {
      scrollToNewest();
    }
  }, [enabled, watch, scrollToNewest]);

  // The unconditional jump: Sending an Entry must land at the newest end
  // and re-engage the pin no matter where the reader currently is —
  // unlike `watch` above, this ignores the current pin state entirely.
  useEffect(() => {
    if (!enabled || forceToNewest === undefined) {
      return;
    }
    jumpToNewest();
  }, [enabled, forceToNewest, jumpToNewest]);

  return {
    scrollRef,
    handleScroll,
    awayFromNewest: enabled && awayFromNewest,
    jumpToNewest,
  };
}
