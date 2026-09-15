import { measureElement as measureElementDefault, useVirtualizer } from "@tanstack/react-virtual";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResizeObserverStub, stubOffsetSize } from "@/test/virtualized-scroll";
import { usePinnedScroll } from "./use-pinned-scroll";

afterEach(() => {
  vi.restoreAllMocks();
});

// jsdom lays nothing out, so scrollHeight/clientHeight are always 0 unless
// a test overrides them — this is what makes "at the newest end" vs.
// "scrolled away" something a test can actually put the element into.
function setScrollGeometry(
  el: HTMLElement,
  {
    scrollHeight,
    clientHeight,
    scrollTop,
  }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

interface HarnessProps {
  enabled: boolean;
  watch: unknown;
  forceToNewest?: unknown;
  pagination?: { hasMore: boolean; fetching: boolean; fetchMore: () => void };
  seeking?: boolean;
  scrollToNewestIndex?: () => boolean;
}

function Harness({
  enabled,
  watch,
  forceToNewest,
  pagination,
  seeking,
  scrollToNewestIndex,
}: HarnessProps) {
  const { scrollRef, handleScroll, awayFromNewest, jumpToNewest } = usePinnedScroll({
    enabled,
    watch,
    forceToNewest,
    pagination,
    seeking,
    scrollToNewestIndex,
  });
  return (
    <div>
      <div data-testid="scroller" ref={scrollRef} onScroll={handleScroll} />
      <p data-testid="away">{String(awayFromNewest)}</p>
      <button type="button" onClick={jumpToNewest}>
        Jump to newest
      </button>
    </div>
  );
}

describe("usePinnedScroll", () => {
  it("stays pinned and follows when new content arrives while already at the newest end", () => {
    const { rerender } = render(<Harness enabled watch={1} />);
    const scroller = screen.getByTestId("scroller");
    // A view that has never scrolled starts pinned (ticket 53: opens at the newest Entry).
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 1000 });

    // New content arrives (`watch` changes) and grows the scrollable area.
    setScrollGeometry(scroller, { scrollHeight: 1400, clientHeight: 400, scrollTop: 1000 });
    rerender(<Harness enabled watch={2} />);

    expect(scroller.scrollTop).toBe(1400);
    expect(screen.getByTestId("away")).toHaveTextContent("false");
  });

  it("does not move the view when new content arrives after the reader scrolled away", () => {
    const { rerender } = render(<Harness enabled watch={1} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 1000 });

    // The reader scrolls up, away from the newest end.
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("away")).toHaveTextContent("true");

    // An Entry arrives from Sync — the view must not be yanked back down.
    setScrollGeometry(scroller, { scrollHeight: 1400, clientHeight: 400, scrollTop: 0 });
    rerender(<Harness enabled watch={2} />);

    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByTestId("away")).toHaveTextContent("true");
  });

  it("re-engages the pin once the reader scrolls back to the newest end", () => {
    render(<Harness enabled watch={1} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("away")).toHaveTextContent("true");

    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 1000 });
    fireEvent.scroll(scroller);

    expect(screen.getByTestId("away")).toHaveTextContent("false");
  });

  it("jumps to the newest end and re-engages the pin unconditionally when forceToNewest changes, however far away the reader is", () => {
    const { rerender } = render(<Harness enabled watch={1} forceToNewest={0} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("away")).toHaveTextContent("true");

    // Sending an Entry: bump forceToNewest, regardless of the current pin state.
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    rerender(<Harness enabled watch={1} forceToNewest={1} />);

    expect(scroller.scrollTop).toBe(1000);
    expect(screen.getByTestId("away")).toHaveTextContent("false");
  });

  it("the jump-to-newest control's action scrolls to the newest end and re-engages the pin", () => {
    render(<Harness enabled watch={1} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("away")).toHaveTextContent("true");

    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Jump to newest" }));

    expect(scroller.scrollTop).toBe(1000);
    expect(screen.getByTestId("away")).toHaveTextContent("false");
  });

  // The bug this branch fixes: a virtualized thread (History) sizes an
  // unmeasured row by *estimate*, so `scrollHeight` right after a jump can
  // itself be wrong — not just where `scrollTop` lands inside it. A single
  // assignment can't tell the difference (both numbers come from the same
  // estimate the instant it's made); only re-checking after the browser has
  // had a chance to measure and correct can. `scrollToNewest`'s own doc
  // comment (use-pinned-scroll.ts) has the full mechanism this covers.
  describe("scrollToNewest's re-assert loop", () => {
    it("re-asserts the newest-end jump on a later frame once scrollHeight has corrected, landing at the NEW height rather than staying at the first, inflated one", async () => {
      render(<Harness enabled watch={1} />);
      const scroller = screen.getByTestId("scroller");

      // An inflated snapshot — the same shape as the live bug's
      // ~41,000-50,000px estimate against a real ~6,125px. The synchronous
      // jump lands wherever THIS scrollHeight says "newest" is — unchanged
      // from before this fix, and still exactly what the existing "jumps to
      // newest" tests above assert.
      setScrollGeometry(scroller, { scrollHeight: 5000, clientHeight: 400, scrollTop: 0 });
      fireEvent.click(screen.getByRole("button", { name: "Jump to newest" }));
      expect(scroller.scrollTop).toBe(5000);

      // A frame later, rows near the jump have actually rendered, measured,
      // and corrected the container down to its real height — the
      // ResizeObserver-driven correction TanStack Virtual performs live,
      // simulated here the same way every other test in this file fakes
      // layout: by hand. `scrollTop` is left at its stale value (5000) on
      // purpose — nothing in a real browser moves it on its own when
      // content shrinks above the current position.
      Object.defineProperty(scroller, "scrollHeight", { value: 1800, configurable: true });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      // The loop caught the correction and re-asserted against the real
      // height, rather than leaving the reader 3,200px short of the actual
      // newest end.
      expect(scroller.scrollTop).toBe(1800);
    });

    it("keeps re-asserting every frame the target keeps moving, and gives up once its frame budget runs out rather than chasing forever", async () => {
      const scrollToNewestIndex = vi.fn(() => true);
      render(<Harness enabled watch={1} scrollToNewestIndex={scrollToNewestIndex} />);
      const scroller = screen.getByTestId("scroller");
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });

      fireEvent.click(screen.getByRole("button", { name: "Jump to newest" }));
      // Two synchronous calls already happened before any frame runs: the
      // `watch` effect's own unconditional one on mount (a fresh pin starts
      // engaged) and the click's own, which cancels the mount's still-
      // pending re-assert loop and starts a fresh one — see
      // `scrollToNewest`'s own comment on why a later call cancels an
      // earlier one rather than letting two loops run at once.
      expect(scrollToNewestIndex).toHaveBeenCalledTimes(2);

      // A pathological case: the geometry never stops moving (nothing ever
      // reads as "stable"), so the loop would chase it forever without its
      // own budget. 12 matches `SCROLL_TO_NEWEST_MAX_FRAMES`
      // (use-pinned-scroll.ts) — not exported, so re-declared by number
      // here instead.
      const SCROLL_TO_NEWEST_MAX_FRAMES_FOR_TEST = 12;
      for (let frame = 0; frame < SCROLL_TO_NEWEST_MAX_FRAMES_FOR_TEST + 5; frame += 1) {
        Object.defineProperty(scroller, "scrollHeight", {
          value: 1000 + frame,
          configurable: true,
        });
        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });
      }

      // The two synchronous calls above, plus one re-assert per frame up to
      // (not including) the budget itself — the frame that reaches the
      // budget settles without asserting again — never more, however many
      // further frames pass.
      expect(scrollToNewestIndex).toHaveBeenCalledTimes(SCROLL_TO_NEWEST_MAX_FRAMES_FOR_TEST + 1);
    });

    it("does nothing further for an ordinary, non-virtualized thread whose scrollHeight is already real — the loop's own first check already finds it settled", async () => {
      // Reflection's Conversation: no `scrollToNewestIndex` at all, and a
      // real, laid-out `scrollHeight` that never changes on its own — the
      // strict-improvement case this fix's own report has to justify.
      render(<Harness enabled watch={1} />);
      const scroller = screen.getByTestId("scroller");
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });

      fireEvent.click(screen.getByRole("button", { name: "Jump to newest" }));
      expect(scroller.scrollTop).toBe(1000);

      const scrollTopSetter = vi.spyOn(Element.prototype, "scrollTop", "set");
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      // The loop's own first frame found `scrollHeight` unchanged and
      // `isAtNewest()` already true, so it never touched `scrollTop` again.
      expect(scrollTopSetter).not.toHaveBeenCalled();
    });
  });

  // The three tests above prove the settle loop's own decision logic
  // against a hand-simulated `scrollHeight`. This one instead drives a
  // REAL `@tanstack/react-virtual` instance under jsdom — `@/test/
  // virtualized-scroll`'s own measuring harness (`installResizeObserverStub`,
  // `stubOffsetSize`) is what makes that possible at all (its own header
  // comment: without it, jsdom's total absence of a `ResizeObserver` and
  // its always-zero `offsetWidth`/`offsetHeight` leave `virtualizer.range`
  // permanently `null`) — reproducing the actual mechanism behind the live
  // bug rather than a stand-in for it: a virtualizer sizes an unmeasured
  // row by *estimate*, and only rendering, measuring, and correcting a row
  // shrinks `scrollHeight` out from under a jump made against the old
  // estimate.
  //
  // `virtualized-scroll.ts`'s own header comment draws a deliberate line:
  // it measures the virtualizer's OWN geometry (`offsetWidth`/
  // `offsetHeight`), never `scrollHeight`/`clientHeight` — those back
  // `usePinnedScroll`'s pin math, "a distinct concern" its comment says,
  // pointing at this file's own `setScrollGeometry` as the tool for it.
  // Every other test in this file follows that split by faking
  // `scrollHeight` independently of anything a virtualizer computes. This
  // test instead keeps them physically consistent — `scrollHeight` synced
  // to `virtualizer.getTotalSize()` after every render, in a
  // `useLayoutEffect` local to the harness below — because the whole
  // point here is proving the loop reacts correctly when `scrollHeight`
  // moves for the REASON it moves live (a row's real, measured size
  // replacing its estimate), not merely when a test changes the number.
  // In a real browser this synchronisation needs no code at all: the
  // sizer div's own CSS height *is* `scrollHeight`, via layout.
  describe("scrollToNewest against a real virtualizer", () => {
    const ROW_COUNT = 60;
    const ESTIMATE_PX = 100;
    const REAL_ROW_HEIGHT_PX = 20;
    const VIEWPORT_PX = 400;

    function VirtualizedNewestHarness() {
      const parentRef = useRef<HTMLDivElement | null>(null);
      const virtualizer = useVirtualizer({
        count: ROW_COUNT,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ESTIMATE_PX,
        overscan: 5,
        getItemKey: (index) => index,
        // Mirrors history.tsx's own override verbatim (its own comment
        // there): a row measured to a real `0` under jsdom is "not
        // actually measured," so this keeps whatever size it already had
        // instead of collapsing it. Every row in this harness gets its
        // `offsetHeight` stubbed to a real, non-zero value before this
        // ever runs (the row `ref` below), so that branch never actually
        // triggers here — kept for fidelity with production anyway, since
        // this harness exists to mirror it.
        measureElement: (element, entry, instance) => {
          const measured = measureElementDefault(element, entry, instance);
          if (measured > 0) {
            return measured;
          }
          const index = instance.indexFromElement(element);
          const key = instance.options.getItemKey(index);
          return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
        },
      });

      // history.tsx's own `registerScrollToNewest` registration, reproduced
      // directly rather than through Shell/History: `virtualizer.scrollToIndex`
      // is the exact call this option exists to hand off to (`scrollToNewestIndex`'s
      // own doc comment, use-pinned-scroll.ts).
      const scrollToNewestIndex = useCallback(() => {
        virtualizer.scrollToIndex(ROW_COUNT - 1, { align: "end" });
        return true;
      }, [virtualizer]);

      const { scrollRef, jumpToNewest } = usePinnedScroll({
        enabled: true,
        watch: ROW_COUNT,
        scrollToNewestIndex,
      });

      // This harness's own stand-in for real layout (this describe block's
      // own header comment) — keeps `scrollHeight` truthful to whatever the
      // virtualizer currently believes the total is, the same relationship
      // a real browser maintains for free.
      useLayoutEffect(() => {
        const el = parentRef.current;
        if (!el) {
          return;
        }
        Object.defineProperty(el, "scrollHeight", {
          value: virtualizer.getTotalSize(),
          configurable: true,
        });
        Object.defineProperty(el, "clientHeight", {
          value: VIEWPORT_PX,
          configurable: true,
        });
      });

      return (
        <div>
          <div
            data-testid="viewport"
            ref={(el) => {
              parentRef.current = el;
              scrollRef.current = el;
            }}
            style={{ overflow: "auto", height: VIEWPORT_PX }}
          >
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => (
                <div
                  key={item.key}
                  data-index={item.index}
                  data-testid={`row-${item.index}`}
                  ref={(el) => {
                    // Stubbed BEFORE delegating to the virtualizer's own
                    // `measureElement`, so the very first, synchronous
                    // measurement it performs on mount (virtual-core's own
                    // `this.measureElement`, called the instant a row's ref
                    // attaches) already reads this row's real height — not
                    // jsdom's default zero, and not the `ESTIMATE_PX` guess
                    // either. This is what makes a row's cached size drop
                    // from the estimate to the real height the moment it
                    // first renders, the same correction a real browser
                    // performs via actual layout.
                    if (el) {
                      stubOffsetSize(el, { width: VIEWPORT_PX, height: REAL_ROW_HEIGHT_PX });
                    }
                    virtualizer.measureElement(el);
                  }}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  Row {item.index}
                </div>
              ))}
            </div>
          </div>
          <button type="button" onClick={jumpToNewest}>
            Jump to newest
          </button>
        </div>
      );
    }

    it("lands genuinely at the newest row once measurement corrects the estimate, not wherever the first, inflated jump left it", async () => {
      const { triggerResize } = installResizeObserverStub();
      render(<VirtualizedNewestHarness />);
      const viewport = screen.getByTestId("viewport");

      // jsdom's own `Element.prototype.scrollTo` is a no-op (jsdom does no
      // layout, so it has nothing to scroll) — @tanstack/virtual-core's
      // `elementScroll` (its own default `scrollToFn`) calls exactly that
      // method rather than assigning `scrollTop` directly, so without this
      // the virtualizer's own jump would silently do nothing under jsdom.
      // Dispatching a real "scroll" event afterward matters just as much:
      // virtual-core's own `observeElementOffset` learns the current
      // offset by LISTENING for that event (`observeOffset`, virtual-core),
      // not by re-reading `scrollTop` on its own — a real browser fires it
      // for a programmatic `scrollTo` exactly as it would for a user's own
      // scroll, and jsdom does not, so without this the DOM's `scrollTop`
      // would change but the virtualizer would never find out. This is the
      // harness's own stand-in for both pieces of that missing browser
      // behaviour — not a fake for anything `usePinnedScroll` itself does
      // (its own DOM-fallback path already writes `scrollTop` directly and
      // needs no such polyfill, per the earlier tests in this file).
      // Cast: this only implements `scrollTo`'s options-bag overload, not
      // its `(x, y)` sibling — the only shape `elementScroll` ever calls it
      // with (virtual-core's own source).
      viewport.scrollTo = ((options?: ScrollToOptions) => {
        const top = options?.top;
        if (typeof top === "number") {
          viewport.scrollTop = top;
          viewport.dispatchEvent(new Event("scroll"));
        }
      }) as typeof viewport.scrollTo;

      // Before the viewport has a real, measured size, `usePinnedScroll`'s
      // mount-time `watch` effect has already tried `scrollToNewest()` once
      // — with `scrollTo` not yet polyfilled — so it did nothing. Only once
      // `triggerResize` below gives the virtualizer its first genuine size
      // does anything actually move: it lands `usePinnedScroll` in its own,
      // real issue #126 re-pin path (a resize of the pinned region, its own
      // ResizeObserver — observing this exact element, since it too went
      // through `installResizeObserverStub`'s stubbed global — re-engages
      // the jump), the identical mechanism a real Composer round trip hits
      // once its layout is first measured.
      stubOffsetSize(viewport, { width: VIEWPORT_PX, height: VIEWPORT_PX });

      // The settle loop's own bound (`SCROLL_TO_NEWEST_MAX_FRAMES`,
      // use-pinned-scroll.ts) — flushing exactly this many frames after the
      // resize guarantees the loop has stopped one way or another by the
      // end, whether it converged early or gave up. 12 mirrors that private
      // constant the same way this file's other tests already do.
      await act(async () => {
        triggerResize(viewport);
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      });

      // Genuinely converged, not merely "wherever the first, inflated jump
      // left it": the newest row actually rendered (proving the loop kept
      // chasing far enough to bring it into view, rather than stopping at
      // whatever estimate-based window the very first jump landed on)...
      expect(screen.getByTestId(`row-${ROW_COUNT - 1}`)).toBeInTheDocument();
      // ...and the final, settled geometry — synced to the virtualizer's
      // own now-corrected total, this describe block's own header comment
      // — reads genuinely "at the newest end," the identical pixel check
      // `isAtNewest` itself uses (NEWEST_THRESHOLD_PX, use-pinned-scroll.ts).
      const NEWEST_THRESHOLD_PX_FOR_TEST = 24;
      expect(
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      ).toBeLessThanOrEqual(NEWEST_THRESHOLD_PX_FOR_TEST);
    });
  });

  it("never reports away from the newest end when disabled", () => {
    render(<Harness enabled={false} watch={1} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);

    expect(screen.getByTestId("away")).toHaveTextContent("false");
  });

  // Issue #81, fix 5: `scrollToNewest` reads `el.scrollHeight`, which
  // forces a synchronous layout of the whole pinned list — expensive for a
  // History with hundreds of Entries. Two effects can each call it on
  // mount: the `watch` effect (unconditional here, since a fresh pin
  // starts engaged) and the `forceToNewest` effect, which is supposed to
  // skip a mount via `forceToNewest === undefined`. `scrollHeight` is a
  // getter on `Element.prototype` in jsdom (confirmed by inspecting its
  // own property descriptor), so spying on that specific accessor —
  // rather than on `scrollToNewest` itself, which the hook never exposes —
  // counts exactly how many times a full-list layout read actually
  // happened, with no other reads competing for the count here (the only
  // other `scrollHeight` read in this hook, inside `isAtNewest`, only runs
  // from a real scroll event, never during mount).
  it("reads scrollHeight (forces a reflow) only once at mount when forceToNewest starts undefined", () => {
    const scrollHeightReads = vi.spyOn(Element.prototype, "scrollHeight", "get");

    render(<Harness enabled watch={1} forceToNewest={undefined} />);

    // The `watch` effect's own unconditional read (a fresh pin starts
    // engaged) — this one is unavoidable and not what issue #81 is about.
    expect(scrollHeightReads).toHaveBeenCalledTimes(1);
  });

  // The seed this guards against: composer-page.tsx used to start its own
  // `forceToNewest` counter at `0` rather than `undefined`, which defeats
  // the hook's own `forceToNewest === undefined` mount guard (`0 !==
  // undefined`) and runs a second, redundant reflow-forcing
  // `scrollToNewest` back to back with the `watch` effect's. This test
  // pins that failure mode at the hook's own level, independent of
  // composer-page.tsx, as the thing the seed fix (`useState<number |
  // undefined>(undefined)`, not `useState(0)`) exists to avoid.
  it("reads scrollHeight twice at mount if forceToNewest is seeded at 0 instead of undefined — the bug the seed fix avoids", () => {
    const scrollHeightReads = vi.spyOn(Element.prototype, "scrollHeight", "get");

    render(<Harness enabled watch={1} forceToNewest={0} />);

    expect(scrollHeightReads).toHaveBeenCalledTimes(2);
  });

  it("still jumps to newest unconditionally on the very first Send when forceToNewest starts undefined", () => {
    const { rerender } = render(<Harness enabled watch={1} forceToNewest={undefined} />);
    const scroller = screen.getByTestId("scroller");

    // The reader has scrolled away before ever Sending anything.
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("away")).toHaveTextContent("true");

    // The first Send: composer-page.tsx's own `(count ?? 0) + 1` turns
    // `undefined` into `1`, which is what actually reaches this hook.
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    rerender(<Harness enabled watch={1} forceToNewest={1} />);

    expect(scroller.scrollTop).toBe(1000);
    expect(screen.getByTestId("away")).toHaveTextContent("false");
  });

  // Issue #79: reaching the oldest loaded edge triggers `pagination.fetchMore`.
  describe("pagination", () => {
    function pagination(overrides: Partial<{ hasMore: boolean; fetching: boolean }> = {}) {
      const fetchMore = vi.fn();
      return { hasMore: true, fetching: false, ...overrides, fetchMore };
    }

    it("calls fetchMore once the reader scrolls to the oldest loaded edge", () => {
      const p = pagination();
      render(<Harness enabled watch={1} pagination={p} />);
      const scroller = screen.getByTestId("scroller");

      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
      fireEvent.scroll(scroller);

      expect(p.fetchMore).toHaveBeenCalledTimes(1);
    });

    it("does not call fetchMore while scrolled away from the oldest edge", () => {
      const p = pagination();
      render(<Harness enabled watch={1} pagination={p} />);
      const scroller = screen.getByTestId("scroller");

      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 500 });
      fireEvent.scroll(scroller);

      expect(p.fetchMore).not.toHaveBeenCalled();
    });

    it("does not call fetchMore once hasMore is false — nothing older left to fetch", () => {
      const p = pagination({ hasMore: false });
      render(<Harness enabled watch={1} pagination={p} />);
      const scroller = screen.getByTestId("scroller");

      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
      fireEvent.scroll(scroller);

      expect(p.fetchMore).not.toHaveBeenCalled();
    });

    it("does not call fetchMore again while a fetch is already in flight", () => {
      const p = pagination({ fetching: true });
      render(<Harness enabled watch={1} pagination={p} />);
      const scroller = screen.getByTestId("scroller");

      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
      fireEvent.scroll(scroller);

      expect(p.fetchMore).not.toHaveBeenCalled();
    });

    it("never reads scrollTop for this at all when pagination is left undefined — a thread with no paging stays inert", () => {
      // No spy needed on scrollTop specifically (jsdom doesn't expose it as
      // a spyable accessor the way scrollHeight is — see the "reads
      // scrollHeight" tests below), so this instead proves the outward
      // symptom: with no `pagination`, a scroll event at the very top does
      // nothing extra beyond the ordinary pin bookkeeping.
      render(<Harness enabled watch={1} />);
      const scroller = screen.getByTestId("scroller");

      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
      expect(() => fireEvent.scroll(scroller)).not.toThrow();
      expect(screen.getByTestId("away")).toHaveTextContent("true");
    });

    // The core of issue #79's "prepending must not move the viewport":
    // once the older page's Entries land (`watch` changes) after a
    // fetchMore this hook itself triggered, scrollTop is adjusted by
    // exactly how much scrollHeight grew above the reader — so whatever
    // content they were looking at stays under them, pixel for pixel.
    it("preserves the reader's visual position once an older page lands above them", () => {
      const p = pagination();
      const { rerender } = render(<Harness enabled watch={1} pagination={p} />);
      const scroller = screen.getByTestId("scroller");

      // Scrolled to the very top of what's loaded so far.
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
      fireEvent.scroll(scroller);
      expect(p.fetchMore).toHaveBeenCalledTimes(1);

      // The older page's Entries land, growing the content above the
      // reader by 300px — jsdom doesn't reflow on its own, so the test
      // sets the new scrollHeight by hand, the same way every other test
      // in this file simulates layout.
      setScrollGeometry(scroller, { scrollHeight: 1300, clientHeight: 400, scrollTop: 0 });
      rerender(<Harness enabled watch={2} pagination={p} />);

      // scrollTop moved by exactly the height added above (1300 - 1000 =
      // 300), so the reader is still looking at the same content.
      expect(scroller.scrollTop).toBe(300);
    });

    // The failure mode this must not reintroduce: an ordinary append while
    // scrolled away (a Sync-delivered Entry landing at the newest,
    // *bottom* end) also grows scrollHeight, but nothing above the reader
    // actually moved — adjusting scrollTop for that would itself be the
    // bug. This is exactly the "does not move the view when new content
    // arrives after the reader scrolled away" case above, just asserted
    // again here with `pagination` present, to prove the two mechanisms
    // don't interfere with each other.
    it("does not adjust scroll position for an ordinary append while scrolled away, even with pagination configured", () => {
      const p = pagination();
      const { rerender } = render(<Harness enabled watch={1} pagination={p} />);
      const scroller = screen.getByTestId("scroller");

      // Scrolled away, but not all the way to the oldest edge — no
      // fetchMore triggered.
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 500 });
      fireEvent.scroll(scroller);
      expect(p.fetchMore).not.toHaveBeenCalled();

      // An Entry arrives from Sync, appended at the newest end.
      setScrollGeometry(scroller, { scrollHeight: 1400, clientHeight: 400, scrollTop: 500 });
      rerender(<Harness enabled watch={2} pagination={p} />);

      expect(scroller.scrollTop).toBe(500);
    });

    // Mirrors the "reads scrollHeight once" test above (issue #81): a
    // thread with `pagination` configured but never actually triggering a
    // fetch (never reaching the oldest edge) must not add a second,
    // unconditional `scrollHeight` read on top of the `watch` effect's own
    // one — only an anchor this hook itself set should ever trigger the
    // extra read the prepend-preserving effect does.
    it("reads scrollHeight only once at mount with pagination configured but never triggered", () => {
      const scrollHeightReads = vi.spyOn(Element.prototype, "scrollHeight", "get");
      const p = pagination();

      render(<Harness enabled watch={1} forceToNewest={undefined} pagination={p} />);

      expect(scrollHeightReads).toHaveBeenCalledTimes(1);
      expect(p.fetchMore).not.toHaveBeenCalled();
    });
  });

  // Issue #142: this is the regression guard for the whole date-Reference
  // seek feature (composer-page.tsx, history.tsx). A seek pages through
  // older Entries in quick succession — each page changes `watch` exactly
  // like an ordinary page load does — and without `seeking` forcing the pin
  // off, the very first page the seek loads would read as "new content
  // while pinned" and yank the reader straight back to the newest end
  // before the seek has gone anywhere.
  describe("seeking", () => {
    it("does not scroll to newest when watch changes while seeking", () => {
      const { rerender } = render(<Harness enabled watch={1} seeking />);
      const scroller = screen.getByTestId("scroller");
      // Pinned (the reader opened at the newest end) before the seek starts.
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 1000 });

      // A page the seek loaded lands, growing the scrollable area — an
      // ordinary "new content" signal, except the seek is in progress.
      setScrollGeometry(scroller, { scrollHeight: 1400, clientHeight: 400, scrollTop: 1000 });
      rerender(<Harness enabled watch={2} seeking />);

      expect(scroller.scrollTop).toBe(1000);
    });

    it("resumes following watch once seeking ends and the reader is still pinned", () => {
      const { rerender } = render(<Harness enabled watch={1} seeking={false} />);
      const scroller = screen.getByTestId("scroller");
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 1000 });

      setScrollGeometry(scroller, { scrollHeight: 1400, clientHeight: 400, scrollTop: 1000 });
      rerender(<Harness enabled watch={2} seeking={false} />);

      expect(scroller.scrollTop).toBe(1400);
    });

    it("stays pinned off after the seek ends, even though the reader had been pinned when it started — landing on a historical day is itself 'away from the newest end'", () => {
      const { rerender } = render(<Harness enabled watch={1} seeking={false} />);
      const scroller = screen.getByTestId("scroller");
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 1000 });

      // The seek runs (loads a page, `watch` changes) and then ends —
      // composer-page.tsx's own sequence once History finds the target day.
      // The seek itself does not move `scrollTop` here (History's own
      // `scrollToIndex` is a virtualizer concern this bare harness has no
      // stand-in for), but the pin must not silently resume as if nothing
      // happened.
      setScrollGeometry(scroller, { scrollHeight: 1400, clientHeight: 400, scrollTop: 1000 });
      rerender(<Harness enabled watch={2} seeking />);
      rerender(<Harness enabled watch={2} seeking={false} />);

      // A later, unrelated `watch` change (an Entry syncing in) must not
      // jump back to the newest end — the seek left the reader pinned off,
      // exactly as a manual scroll-up would have.
      setScrollGeometry(scroller, { scrollHeight: 1800, clientHeight: 400, scrollTop: 1000 });
      rerender(<Harness enabled watch={3} seeking={false} />);

      expect(scroller.scrollTop).toBe(1000);
    });

    // Same stub as the "re-pinning when the region itself resizes" describe
    // block below, kept local to this one test rather than shared: this is
    // the only test in this describe block that needs the ResizeObserver
    // callback itself, as opposed to `seeking`'s effect on ordinary `watch`
    // changes.
    it("does not re-pin on a resize while seeking", () => {
      let notifyResize: (() => void) | null = null;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            notifyResize = callback;
          }
          observe() {}
          disconnect() {}
        },
      );

      render(<Harness enabled watch={1} seeking />);
      const scroller = screen.getByTestId("scroller");
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

      // The region shrinks — ordinarily this snaps a pinned reader back to
      // the newest end (issue #126) — but a seek must not be interrupted by
      // it either.
      setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 100, scrollTop: 600 });
      act(() => notifyResize?.());

      expect(scroller.scrollTop).toBe(600);
      vi.unstubAllGlobals();
    });
  });
});

// Issue #126: the box changing is as much a reason to re-pin as new content
// arriving. The soft keyboard, a growing Composer and a rotation all shrink
// the scroll region without adding an Entry to it, and a browser preserves
// `scrollTop` across all three — which walks the newest Entry off the bottom.
describe("usePinnedScroll re-pinning when the region itself resizes", () => {
  // The stub records what it was asked to watch as well as capturing the
  // callback. Capturing alone let a mutation that never calls `observe()` at
  // all pass every test here — the callback still existed to be fired, so
  // the suite proved the reaction without proving the subscription.
  let notifyResize: (() => void) | null = null;
  let observedTargets: Element[] = [];

  beforeEach(() => {
    notifyResize = null;
    observedTargets = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe(target: Element) {
          observedTargets.push(target);
        }
        disconnect() {
          notifyResize = null;
          observedTargets = [];
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("watches the scroll region itself, not some other element", () => {
    render(<Harness enabled watch={1} />);

    expect(observedTargets).toEqual([screen.getByTestId("scroller")]);
  });

  it("stops watching when it unmounts", () => {
    const { unmount } = render(<Harness enabled watch={1} />);
    expect(notifyResize).not.toBeNull();

    unmount();

    expect(notifyResize).toBeNull();
  });

  it("returns to the newest end when the region shrinks under a pinned reader", () => {
    render(<Harness enabled watch={1} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    // The keyboard opens: the region is shorter, `scrollTop` is untouched,
    // and the reader is 300px from the bottom without having moved.
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 100, scrollTop: 600 });
    act(() => notifyResize?.());

    expect(scroller.scrollTop).toBe(1000);
  });

  it("leaves a reader who scrolled away exactly where they are", () => {
    render(<Harness enabled watch={1} />);
    const scroller = screen.getByTestId("scroller");
    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    fireEvent.scroll(scroller);

    setScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 100, scrollTop: 100 });
    act(() => notifyResize?.());

    expect(scroller.scrollTop).toBe(100);
  });
});
