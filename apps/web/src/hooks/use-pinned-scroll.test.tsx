import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}

function Harness({ enabled, watch, forceToNewest, pagination }: HarnessProps) {
  const { scrollRef, handleScroll, awayFromNewest, jumpToNewest } = usePinnedScroll({
    enabled,
    watch,
    forceToNewest,
    pagination,
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
