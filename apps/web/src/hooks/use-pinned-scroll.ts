import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * How close to the newest (bottom) edge counts as "at" it, in pixels.
 * `scrollHeight - scrollTop - clientHeight` is only ever exactly 0 after a
 * layout that lands on a whole pixel; a little slack keeps a
 * fractional-pixel remainder (subpixel rendering, a scrollbar rounding
 * error) from reading as "scrolled away" when the reader is, as far as
 * they can tell, at the bottom.
 */
const NEWEST_THRESHOLD_PX = 24;

/**
 * The oldest-edge sibling of NEWEST_THRESHOLD_PX (issue #79): how close to
 * the top counts as "reached the oldest loaded Entry," the cue to fetch an
 * older page. Same slack, same reason — `scrollTop` alone rarely lands on
 * exactly 0.
 */
const OLDEST_THRESHOLD_PX = 24;

export interface UsePinnedScrollOptions {
  /** Off entirely for pages with no pinned thread — Settings is the only one. */
  enabled: boolean;
  /**
   * Whatever value changes exactly when new content that might need
   * following has appeared — the caller's Entries array, typically. This
   * hook has no notion of "Entry" itself, on purpose (ticket 53: the pin is
   * a view-only concern, not a store one — see ADR 0018).
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
  /**
   * Issue #79: when provided, reaching the oldest loaded edge (scrolling
   * to the top) calls `fetchMore` — once, guarded by `hasMore` and
   * `fetching` so it neither fetches past the end of History nor
   * re-triggers a fetch already in flight. Absent for threads with no
   * pagination (Reflection's Conversation) — see UseHistoryPagination
   * (use-history.ts), the shape this is written to accept directly.
   */
  pagination?: {
    hasMore: boolean;
    fetching: boolean;
    fetchMore: () => void;
  };
  /**
   * Issue #83: an override for "jump to the newest end," tried before the
   * default `el.scrollTop = el.scrollHeight` assignment rather than
   * instead of it. With a virtualized thread (History), only rows near the
   * viewport actually exist in the DOM — `scrollHeight` is still accurate
   * (it's the virtualizer's own reported total, not a real laid-out
   * height), but the *newest* row may still be at its estimated size if it
   * has never been measured, which is exactly the moment a reader jumps to
   * it (a fresh mount, or the very first Send after scrolling away). The
   * caller hands this hook a function that reaches for the virtualizer's
   * own `scrollToIndex` instead, which re-measures and corrects after the
   * initial jump rather than trusting an assignment made against an
   * estimate.
   *
   * Returns whether it actually handled the jump, not `void` — Shell
   * (shell.tsx) passes the *same* function on every page it renders,
   * including ones with no virtualizer at all (Reflection's Conversation),
   * because it has no way to know from here which kind of thread this is.
   * Returning `false` (nothing registered to receive the jump) is what
   * tells this hook to fall through to the scrollHeight-based default
   * instead of silently doing nothing — the shape a plain callback
   * couldn't express. Undefined here (every test in
   * use-pinned-scroll.test.tsx) is indistinguishable from "always returns
   * false": both leave the scrollHeight-based jump as the only thing that
   * ever runs, which is what keeps every existing assertion in that file
   * unchanged by this option's addition.
   */
  scrollToNewestIndex?: () => boolean;
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
  pagination,
  scrollToNewestIndex,
}: UsePinnedScrollOptions): UsePinnedScrollResult {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // A ref alongside the state: the effects below need the *current* pin
  // state synchronously (to decide whether to follow), not the value from
  // whatever render closed over them — state alone would only ever see the
  // value as of the last render.
  const pinnedRef = useRef(true);
  const [awayFromNewest, setAwayFromNewest] = useState(false);
  // Issue #79: set the instant a "fetch an older page" request goes out,
  // holding exactly the geometry `scrollTop`/`scrollHeight` had at that
  // moment — cleared, and acted on, by the layout effect below once the
  // older page's Entries actually land and grow the content above the
  // reader. `null` the rest of the time, including whenever `pagination`
  // is never provided at all — that's what keeps this whole mechanism
  // inert for a thread with no paging (Reflection's Conversation), down to
  // never reading `scrollHeight` on its account.
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const isAtNewest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return true;
    }
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEWEST_THRESHOLD_PX;
  }, []);

  const scrollToNewest = useCallback(() => {
    // Issue #83: give the caller's own idea of "newest" (the virtualizer's
    // scrollToIndex, for History) first refusal — see
    // `scrollToNewestIndex`'s own doc comment for why this is a boolean
    // hand-off rather than either function unconditionally winning.
    if (scrollToNewestIndex?.()) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [scrollToNewestIndex]);

  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setAwayFromNewest(!next);
  }, []);

  const jumpToNewest = useCallback(() => {
    scrollToNewest();
    setPinned(true);
  }, [scrollToNewest, setPinned]);

  // Issue #79: reaching the oldest loaded edge is the cue to fetch the
  // next older page — nothing is prefetched ahead of that (the ticket's
  // own acceptance criterion), so this only ever fires from a real scroll
  // event, never speculatively. Guarded on `hasMore`/`fetching` so sitting
  // at the top (a bounce, a second scroll event before the fetch's own
  // state update lands) can't queue up more than one fetch, and a thread
  // with `pagination` left undefined never reads `scrollTop` for this at
  // all. The anchor captured here — this element's geometry *before* the
  // older page's Entries land — is what the layout effect below uses to
  // keep the reader's view from jumping once they do.
  const maybeFetchOlderPage = useCallback(() => {
    if (!pagination?.hasMore || pagination.fetching) {
      return;
    }
    const el = scrollRef.current;
    if (!el || el.scrollTop > OLDEST_THRESHOLD_PX) {
      return;
    }
    prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    pagination.fetchMore();
  }, [pagination]);

  // Scrolling disengages the pin the moment the reader leaves the newest
  // end, and re-engages it the moment they scroll back — the same check
  // both directions, driven by the element's own scroll position rather
  // than tracked some other way. The oldest-edge check above rides the
  // same scroll event: both ends of the thread are handled by one
  // listener, matching how Shell wires exactly one `onScroll` to this.
  const handleScroll = useCallback(() => {
    setPinned(isAtNewest());
    maybeFetchOlderPage();
  }, [isAtNewest, setPinned, maybeFetchOlderPage]);

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

  // Issue #79: preserves scroll position across an older page landing
  // above the reader (`watch` changing while `prependAnchorRef` is set —
  // see maybeFetchOlderPage above for when that happens). A `useLayoutEffect`
  // rather than a plain `useEffect` deliberately: it runs after the DOM
  // reflects the newly-prepended Entries but *before* the browser paints,
  // which is what makes the adjustment invisible instead of a one-frame
  // jump-then-correct flash.
  //
  // The adjustment itself is "however much scrollHeight grew above where
  // the reader was, move scrollTop by the same amount" — it doesn't need
  // to know how many Entries landed or how tall they render, only the
  // before/after height, so it stays correct however the older page's
  // content actually lays out (day separators, multi-line bodies, and so
  // on all already factor into scrollHeight by the time this reads it).
  //
  // Guarded on `prependAnchorRef.current` rather than running unconditionally
  // whenever `watch` changes and the thread isn't pinned: an ordinary
  // append while scrolled away (a Sync-delivered Entry landing at the
  // newest end, say) changes `scrollHeight` too, but *below* the reader,
  // where no compensation is needed or wanted — adjusting `scrollTop` for
  // that would itself be the bug, moving a view that correctly has nothing
  // to correct for. Only an anchor this hook itself just set (meaning:
  // this specific `watch` change is the older page maybeFetchOlderPage
  // asked for) makes the adjustment run, which is also exactly why a
  // thread with no `pagination` at all never sets one and this effect
  // never reads `scrollHeight` on its account (see the "reads scrollHeight
  // once" test in use-pinned-scroll.test.tsx, which this must not add a
  // second, unconditional read to).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` stands in for "content changed," the same reason the follow effect below only depends on it — this must re-run when the older page's Entries actually land, not on unrelated renders.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!enabled || anchor === null) {
      return;
    }
    prependAnchorRef.current = null;
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [enabled, watch]);

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
