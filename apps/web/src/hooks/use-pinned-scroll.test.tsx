import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
}

function Harness({ enabled, watch, forceToNewest }: HarnessProps) {
  const { scrollRef, handleScroll, awayFromNewest, jumpToNewest } = usePinnedScroll({
    enabled,
    watch,
    forceToNewest,
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
});
