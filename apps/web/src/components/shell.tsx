import { ArrowDown, ArrowLeft, Search as SearchIcon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigationType } from "react-router";
import { SyncStatusIndicator } from "@/components/sync-status-indicator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePinnedScroll } from "@/hooks/use-pinned-scroll";
import { cn } from "@/lib/utils";

/**
 * Issue #83: what history.tsx's virtualizer needs from Shell, and the one
 * thing Shell needs back from it.
 *
 * `scrollElement` exists here, rather than a ref History creates itself,
 * because Shell — not History — owns the actual scrollable node: it's this
 * file's own `scrollRef` below, already wired to `usePinnedScroll` for the
 * pin/jump-to-newest logic ADR 0018 and issue #79 depend on. Rendering a
 * second `overflow-y-auto` element inside History instead would give the
 * page two independent scroll positions and break both of those. A plain
 * DOM node in state, not a bare `RefObject` — History's virtualizer must
 * react the moment this becomes non-null (a `RefObject` alone would read
 * `null` on History's very first render, since Shell — the ref's owner —
 * is History's *ancestor*, and refs attach bottom-up: History's own mount
 * effects run before Shell's div ever gets its ref attached). Populating it
 * through a callback ref into `useState` forces the one extra render that
 * makes the real node visible to a descendant reliably, instead of leaving
 * that timing to chance.
 *
 * `registerScrollToNewest` runs the other direction. Only History knows how
 * to reach the newest row once rows are virtualized — most of them don't
 * exist in the DOM at all, and getting to one is `@tanstack/react-virtual`'s
 * `scrollToIndex`, not a `scrollTop` assignment. History calls this once
 * mounted, and again whenever which row counts as "newest" changes, so
 * `usePinnedScroll` (called here in Shell, for the reasons above) can route
 * its jump through the virtualizer instead of the raw `el.scrollTop =
 * el.scrollHeight` it falls back to for every other pinned thread (today,
 * only Reflection's Conversation — see use-pinned-scroll.ts's own
 * `scrollToNewestIndex` option). `null` unregisters, called on unmount so a
 * stale closure over a since-unmounted virtualizer can never fire.
 */
export interface HistoryScrollContextValue {
  scrollElement: HTMLDivElement | null;
  registerScrollToNewest: (fn: (() => void) | null) => void;
}

export const HistoryScrollContext = createContext<HistoryScrollContextValue>({
  scrollElement: null,
  registerScrollToNewest: () => {},
});

interface PinnedThreadConfig {
  /** Changes exactly when new content that might need following has appeared — e.g. the page's Entries array. */
  watch: unknown;
  /** Bump on an action that must jump to the newest end unconditionally — e.g. a counter incremented on Send. See use-pinned-scroll.ts. */
  forceToNewest?: unknown;
  /**
   * Issue #79: passed straight through to usePinnedScroll's own
   * `pagination` option — see that hook for what it does. Undefined for a
   * thread with nothing paginated (Reflection's Conversation), same as
   * composer-page.tsx before this ticket added History's own paging.
   */
  pagination?: {
    hasMore: boolean;
    fetching: boolean;
    fetchMore: () => void;
  };
  /**
   * Issue #83: History bottom-aligns itself now — a leading spacer sized
   * from its own virtualizer, computed in history.tsx (see that file's own
   * comment on why: `justify-end` can't act on rows it can't see, since a
   * virtualized row is `position: absolute` and out of flow). Setting this
   * tells Shell to skip its own `min-h-full justify-end` treatment of the
   * scroll region's content column below rather than layer both on top of
   * each other.
   *
   * That's not just belt-and-braces: both mechanisms try to consume the
   * *same* slack space, and `justify-end`'s contribution feeds back into
   * History's own measurement (the space it adds shows up as more room
   * *above* the virtualized list, which is exactly the quantity History's
   * spacer reacts to). Left running together, each render would correct
   * for the other's last correction and the two would spend it back and
   * forth — half undershooting, forever — rather than ever converging.
   * Reflection's Conversation (reflection-page.tsx) leaves this undefined
   * and keeps the plain CSS treatment: it renders every message for real,
   * so `justify-end` still sees the whole thing and has nothing to fight
   * with.
   */
  ownsBottomAlignment?: boolean;
}

/**
 * Ticket 55: what Search's app-bar mode needs from whichever page turns it
 * on. Deliberately just a string and two callbacks — no `Entry`, no store,
 * no route — because ADR 0008/0009 requires Settings to stay usable even
 * when the Entry store never opens, and Shell renders on every page
 * including Settings. Making the app bar's search affordance depend on
 * anything store-shaped would put that guarantee at risk for no reason:
 * Settings simply never passes this prop (see settings-page.tsx), so it
 * never grows a magnifier at all, without Shell needing to know why.
 *
 * The query itself is owned by the page (a URL param — see
 * use-history-search.ts), not by Shell: Shell only knows how to *show* the
 * field and hand keystrokes back, the same separation `pinnedThread` above
 * already uses for the scroll pin.
 */
export interface ShellSearchConfig {
  query: string;
  onQueryChange: (value: string) => void;
  /**
   * The field was dismissed (the close button, or Escape) — the page's cue
   * to clear the query. Shell itself has no notion of "clear the narrowing"
   * (a URL param today, a sessionStorage backup too — see
   * use-history-search.ts): it just reports that the reader left search
   * mode, same as it reports scroll and click events elsewhere.
   */
  onDismiss: () => void;
  /**
   * What this page's Search narrows — folded into the magnifier's and the
   * field's own `aria-label`/`placeholder` as `Search {label}`. Defaults to
   * `"History"`, the only collection Search narrowed before issue #64, so
   * the Composer (composer-page.tsx, History's one remaining consumer since
   * issue #75 deleted `/history`'s own page) doesn't have to pass it.
   * Sessions (sessions-page.tsx, issue #64) passes `"Sessions"` explicitly —
   * CONTEXT.md is explicit that a Session's Conversation is not History, so
   * labelling its search "Search History" would misname what it actually
   * narrows.
   */
  label?: string;
}

interface ShellProps {
  title: ReactNode;
  /**
   * A leading app-bar slot, before the title. No page passes this today —
   * settings-page.tsx was the one caller, and issue #75 removed its Back
   * button once Settings became a Nav destination in its own right (ADR
   * 0018's "an always-reachable destination doesn't need Back" then applied
   * to Settings the same way it always did to Composer/Reflect/Digest). The
   * slot itself stays: a `ReactNode` slot, not a `backTo: string`, because
   * Shell must stay ignorant of routes, the same reason `action` and `nav`
   * below are slots rather than configuration, and ADR 0008/0009 requires
   * Settings to stay usable even when the Entry store never opens — Shell
   * renders on every page, including Settings, so it can't lean on anything
   * route- or store-shaped to decide what this renders. Rendered only in
   * the non-searching branch of the header below: the searching branch
   * already owns this visual position with its own "Close search" back
   * arrow.
   */
  back?: ReactNode;
  /** Trailing app-bar action — e.g. the History/Settings links on the Composer page. */
  action?: ReactNode;
  message?: string;
  children: ReactNode;
  /** Rendered after `children`, in the same scrollable region — e.g. the Composer page's History. */
  footer?: ReactNode;
  /**
   * The Composer (ticket 51), docked below the scrollable content so it
   * stays put while History scrolls behind it. With ADR 0036 retiring the
   * persistent nav there is nothing under it any more, so the Composer is
   * the pane's own bottom edge and owns `--safe-bottom` outright — see the
   * scroll region's padding comment below for why Shell doesn't duplicate
   * that here.
   */
  composerSlot?: ReactNode;
  /**
   * Ticket 53's conditional pin: opts the scroll region into following
   * newly-appeared content only while the reader is already at the newest
   * (bottom) end, and shows a jump-to-newest control while away from it.
   * Wired by composer-page.tsx and reflection-page.tsx, whose threads grow
   * over time (`/history`, before issue #75 deleted it, also wired this) —
   * Settings and Digest are two pages that leave this undefined, which
   * leaves the scroll region exactly as before. Shell has no notion of
   * "Entry" itself here, deliberately: see use-pinned-scroll.ts.
   */
  pinnedThread?: PinnedThreadConfig;
  /**
   * Ticket 55: the magnifier that turns this app bar into a search field in
   * place, on both destinations that have a thread. Undefined (Settings —
   * see settings-page.tsx) renders the bar exactly as before, with no
   * magnifier at all — "Settings has no thread and must not grow a search
   * affordance" is true by construction, not by a Settings-side check.
   */
  search?: ShellSearchConfig;
}

// The app shell every page renders through (ticket 50, replacing the
// centred max-w-xl Card ticket 25 introduced). A fixed top app bar, a
// scrollable content region, and a reserved composer slot that #51 fills
// in. The nav slot #54 filled is gone with ADR 0036's persistent nav.
//
// This element no longer sizes itself to the window — `chat-shell-layout.tsx`
// does that, and hands each pane a box to fill. `h-full` plus
// `overflow-hidden` is what keeps this a real pane rather than a page that
// grows taller than its box: only the content region scrolls internally.
// That, plus no horizontal overflow anywhere in this tree, is what keeps a
// narrow window free of the page-level scrollbars the old centred-card
// layout never had to avoid.
export function Shell({
  title,
  back,
  action,
  message,
  children,
  footer,
  composerSlot,
  pinnedThread,
  search,
}: ShellProps) {
  // Issue #83: the escape hatch History registers its virtualizer's
  // `scrollToIndex` into (see HistoryScrollContext's own comment above).
  // Held in state, not a ref, and that is the whole point: registration has
  // to be observable. usePinnedScroll's pin effect runs on mount, before
  // History has mounted deep enough to register anything, so a ref would
  // leave it reading null, falling back to `scrollTop = scrollHeight` on a
  // virtual list that has not sized yet (so, zero), and never trying again.
  // On a cold load that went unnoticed because Entries arrive later and
  // change the hook's `watch`, re-running the effect after registration; on
  // a remount the data is already cached, `watch` never changes, and the
  // reader landed on the OLDEST Entries instead of pinned to the newest.
  // Storing the callback in state gives `runRegisteredScrollToNewest` a new
  // identity the moment History registers, which is exactly the signal the
  // hook already knows how to react to.
  const [scrollToNewestFn, setScrollToNewestFn] = useState<(() => void) | null>(null);
  const runRegisteredScrollToNewest = useCallback(() => {
    if (!scrollToNewestFn) {
      // Nothing registered — either no pinned thread on this page is
      // virtualized at all (Reflection's Conversation) or History has not
      // mounted yet. Reporting failure is what tells usePinnedScroll to
      // fall back to its own scrollHeight-based jump rather than silently
      // doing nothing.
      return false;
    }
    scrollToNewestFn();
    return true;
  }, [scrollToNewestFn]);
  // The updater form is required, not stylistic: a bare
  // `setScrollToNewestFn(fn)` would have React *call* `fn` as a reducer.
  const registerScrollToNewest = useCallback((fn: (() => void) | null) => {
    setScrollToNewestFn(() => fn);
  }, []);

  // Issue #83: the scroll element History's virtualizer measures against,
  // populated via a callback ref rather than read straight off `scrollRef`
  // below — see HistoryScrollContext's own comment for why a bare
  // `RefObject` isn't enough for a descendant to react to reliably.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const historyScrollContextValue = useMemo(
    () => ({ scrollElement, registerScrollToNewest }),
    [scrollElement, registerScrollToNewest],
  );

  const { scrollRef, handleScroll, awayFromNewest, jumpToNewest } = usePinnedScroll({
    enabled: pinnedThread !== undefined,
    watch: pinnedThread?.watch,
    forceToNewest: pinnedThread?.forceToNewest,
    pagination: pinnedThread?.pagination,
    scrollToNewestIndex: runRegisteredScrollToNewest,
  });

  // Ticket 55's mode switch: whether the app bar currently shows the search
  // field instead of the title/actions row. Lazily seeded from whether a
  // query is already active (a reload with `?q=`, or a link straight to a
  // narrowed search) so that case renders open on the very first paint
  // instead of flashing the plain bar first. The effect below keeps it in
  // sync afterwards for the case the lazy initializer can't cover: the
  // sessionStorage backup (use-history-search.ts) restores a query one
  // render *after* mount, once its own effect has run.
  //
  // This is deliberately one-way once a query exists: only `dismissSearch`
  // (the close button or Escape) ever sets this back to false. Clearing the
  // field's text by typing must not collapse the bar out from under a
  // reader mid-edit — the reference prototype (#49 variant 08) has the
  // identical rule, only its explicit close control leaves search mode.
  const [searchOpen, setSearchOpen] = useState(
    () => search !== undefined && search.query.trim() !== "",
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: only `search?.query` should re-trigger this — it exists purely to catch a query becoming active *after* mount (the sessionStorage restore in use-history-search.ts), not to react to `onQueryChange`/`onDismiss` identity churning every render.
  useEffect(() => {
    if (search !== undefined && search.query.trim() !== "" && !searchOpen) {
      setSearchOpen(true);
    }
  }, [search?.query]);

  const searching = search !== undefined && searchOpen;

  // `search.label` (issue #64) is what makes this "Search History" on the
  // Composer/History pages and "Search Sessions" on the Sessions page,
  // without either caller having to know the other exists.
  const searchLabel = `Search ${search?.label ?? "History"}`;

  // Which of the four destinations this pane is, and whether we arrived by
  // pushing rather than by loading the URL directly. Both only drive the
  // enter animation — Shell stays ignorant of what any particular route
  // means, the same way it does for `action` and `back`.
  const location = useLocation();
  const navigationType = useNavigationType();
  const destination = location.pathname.split("/")[1] || "root";
  const pushed = navigationType === "PUSH";

  function dismissSearch() {
    setSearchOpen(false);
    search?.onDismiss();
  }

  return (
    // One pane, sized to whatever `chat-shell-layout.tsx` gives it, rather
    // than to the window. That layout owns the window's height, the
    // keyboard custom properties and the two-pane split; this owns an app
    // bar, a scroll region and a docked Composer, and nothing above it.
    //
    // Before ADR 0036 this element WAS the window, and it carried the
    // persistent `<nav>` — one landmark repositioned by CSS between a bottom
    // bar and a left rail. That element is gone rather than moved: a chat
    // list of plain rows has no navigation region present on every page to
    // be one landmark or two, because the list is a screen you navigate away
    // from rather than chrome that stays mounted beside whatever is showing.
    // What replaces it for a screen-reader user is `chat-list.tsx`'s own
    // scoped `<nav aria-label="Chats">` plus a real `href` and
    // `aria-current` on every row.
    //
    // `key` on the destination rather than the whole pathname: `/reflect`
    // and `/reflect/:sessionId` are the same destination, and remounting
    // this subtree between them would throw away the thread's scroll
    // position to replay an animation the reader did not ask for.
    // `navigationType` gates the animation on an actual push, so a direct
    // load or a reload lands without one.
    <div
      key={destination}
      className={cn(
        "flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background",
        pushed &&
          "motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:duration-200",
      )}
    >
      {/* Fixed top app bar: title plus the Sync status dot (ticket 40),
            which loses its home in CardTitle once the Card is gone and
            moves here instead — ambient and always-present on every page,
            unchanged from before. min-h rather than h so the safe-area
            padding-top can grow the bar under a notch/Dynamic Island
            instead of clipping the title against it. */}
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 [padding-top:env(safe-area-inset-top)]">
        {searching && search ? (
          // Ticket 55: the field replaces the title/Sync-dot row and the
          // magnifier entirely rather than appearing alongside them — "in
          // place," not a second row pushing the thread down, which is
          // what makes this agree with CONTEXT.md's "narrows History in
          // place rather than producing a separate collection" for the
          // *navigation* half of Search too, not just the filtering
          // itself.
          //
          // `action` (Settings) stays, deliberately departing from the
          // reference prototype (#49 variant 08), which hides its whole
          // app bar including its Settings icon while searching. Settings
          // is reachable *only* through this app-bar action — it isn't in
          // the persistent Nav (nav.tsx) — so hiding it here would strand
          // a reader who starts a search mid-visit with no way to reach
          // Settings without first dismissing (which clears the query).
          // "The session-storage backup that restores a query after
          // leaving the page still works" is this ticket's own kept
          // guarantee (#55, restating #39): that guarantee is only worth
          // keeping if the round trip through Settings it describes is
          // still reachable while a search is active, not just before one.
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close search"
              onClick={dismissSearch}
              className="shrink-0 text-muted-foreground"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
            </Button>
            <Input
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              autoFocus
              value={search.query}
              onChange={(event) => search.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  dismissSearch();
                }
              }}
              className="h-9 flex-1"
            />
            {action && <div className="ml-auto flex items-center gap-3">{action}</div>}
          </>
        ) : (
          <>
            {back}
            <span className="flex items-center gap-2 font-heading text-base font-medium">
              {title}
              <SyncStatusIndicator />
            </span>
            {(search || action) && (
              <div className="ml-auto flex items-center gap-3">
                {search && (
                  <button
                    type="button"
                    aria-label={searchLabel}
                    onClick={() => setSearchOpen(true)}
                    className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <SearchIcon aria-hidden="true" className="size-4" />
                  </button>
                )}
                {action}
              </div>
            )}
          </>
        )}
      </header>

      {/*
        A positioned wrapper around the scroll region, so the jump-to-newest
        control below can hang at the region's own bottom edge — just above
        the Composer — rather than at the viewport's. It cannot live inside
        the scroll region itself: an absolutely positioned child of a
        scrolling box scrolls away with the content.
      */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The scrollable content region between the app bar and whatever
            sits below it. Full-bleed on a wide window — the reading column
            inside is what's sized, proportionally rather than to a fixed
            cap (ADR 0019): 97% of a narrow window, 85% of the space beside
            the rail on a wide one.
            Plain py-4 is enough here now that the docked Composer (#51)
            claims the bottom edge and handles env(safe-area-inset-bottom)
            itself — padding it again here would double it under a home
            indicator. */}
        <div
          ref={(node) => {
            // Issue #83: this div is both `usePinnedScroll`'s own scroll
            // element (`scrollRef`, unchanged) and the node
            // HistoryScrollContext hands down to History's virtualizer
            // (`scrollElement`, new). Two refs on one JSX element can't be
            // written as `ref={a}` twice, so this callback fans the single
            // attach/detach out to both — `scrollRef.current` synchronously
            // (usePinnedScroll reads it directly, no re-render needed) and
            // `setScrollElement` as state (History, a descendant, needs a
            // value that actually changes to react to — see the context's
            // own comment on why a bare ref isn't enough there).
            scrollRef.current = node;
            setScrollElement(node);
          }}
          onScroll={pinnedThread ? handleScroll : undefined}
          data-testid="shell-scroll-region"
          // `relative` (issue #83): the one thing History's virtualizer
          // needs from this element beyond the ref itself. History measures
          // how much of its own content (a leading spacer, an always-present
          // day pill — see history.tsx) sits above the virtualized list by
          // reading that content's own `offsetTop`, and `offsetTop` is
          // relative to the nearest *positioned* ancestor — with nothing
          // positioned in between, that would otherwise walk all the way up
          // to the document body and return a number that includes the app
          // bar, not just this region's own scrolled content.
          className="relative flex-1 overflow-x-hidden overflow-y-auto"
        >
          <HistoryScrollContext.Provider value={historyScrollContextValue}>
            {/* A pinned thread hugs the bottom when it is shorter than the
              viewport (ticket 53): the newest Entry belongs next to the
              Composer, and top-aligning a two-Entry History leaves it
              stranded at the top above a screen of empty space — the one
              thing that reads as broken rather than merely empty. min-h-full
              gives justify-end something to push against; without it the
              column is only as tall as its content and there is nothing to
              distribute. Settings passes no pinnedThread and keeps the
              ordinary top-aligned flow. Issue #83: a pinned thread that
              bottom-aligns itself (History, via its own virtualized-aware
              leading spacer — see PinnedThreadConfig's own
              `ownsBottomAlignment` comment) skips this treatment rather than
              layering both on top of each other. */}
            <div
              className={cn(
                // ADR 0019's proportional reading column, flipping at the
                // same `md` where the nav becomes a rail — one transition
                // for the eye rather than two. 85% is narrower than 97% at
                // every window size, so the column steps *down* here; that
                // step is the rule's, not a bug in it. px-4 stays inside
                // the percentage, so the text itself lands a few points
                // narrower than the container.
                "mx-auto flex w-[97%] flex-col gap-4 px-4 py-4 md:w-[85%]",
                pinnedThread && !pinnedThread.ownsBottomAlignment && "min-h-full justify-end",
              )}
            >
              {message && <p className="text-sm text-destructive">{message}</p>}
              {children}
              {footer}
            </div>
          </HistoryScrollContext.Provider>
        </div>

        {/*
        Ticket 53's jump-to-newest control. It was a band between the thread
        and the Composer, and that reasoning was sound against the shape it
        was compared to: an overlay hanging at the *viewport's* bottom edge
        covered whatever line happened to sit underneath it, and no padding
        on the content could move it out of the way.

        A circle anchored to the wrapper above rather than to the viewport
        has neither problem. It covers a corner of the thread instead of a
        full line, costs none of the permanent thread height a band claimed,
        and is the shape gesture-memory expects from every other chat
        application.

        No count on it: no read or seen state exists anywhere in this app —
        not on an Entry, not on a Digest, not on a Session — and inventing
        one to fill a badge is a far larger decision than this control.
      */}
        {pinnedThread && awayFromNewest && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="Jump to newest"
            onClick={jumpToNewest}
            className="absolute right-4 bottom-3 z-10 size-10 rounded-full border border-border shadow-md motion-safe:animate-in motion-safe:fade-in"
          >
            <ArrowDown aria-hidden="true" className="size-4" />
          </Button>
        )}
      </div>

      {composerSlot}
    </div>
  );
}
