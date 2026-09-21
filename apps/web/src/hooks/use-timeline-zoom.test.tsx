import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { HistoryScrollContext } from "@/components/shell";
import { useTimelineZoom } from "./use-timeline-zoom";

/**
 * Issue #418: the gesture wiring around `time-zoom.ts`'s pure math.
 *
 * jsdom returns an all-zero `getBoundingClientRect` for every element (it has
 * no layout engine at all — the same limitation `time-lanes.test.ts`'s own
 * header comment names), which is actually useful here: with every rect's
 * `top` at zero, this hook's `timelineTop` measurement collapses to whatever
 * `scrollElement.scrollTop` already was, which jsdom *does* implement as a
 * plain, unclamped read/write property. That is enough to prove the wiring —
 * that a gesture reaches `requestZoom` with the right direction and focal
 * point, and that the result is actually applied to `scrollElement.scrollTop`
 * — without needing real layout.
 */

function Harness() {
  const zoom = useTimelineZoom();
  return (
    <>
      <span data-testid="px-per-hour">{zoom.pxPerHour}</span>
      <button type="button" onClick={zoom.zoomIn} disabled={!zoom.canZoomIn}>
        zoom in
      </button>
      <button type="button" onClick={zoom.zoomOut} disabled={!zoom.canZoomOut}>
        zoom out
      </button>
      <button type="button" onClick={zoom.reset}>
        reset
      </button>
      <div ref={zoom.timelineRef} data-testid="timeline" {...zoom.timelineProps} />
    </>
  );
}

/**
 * Mounts the harness inside a real DOM node acting as `HistoryScrollContext`'s
 * `scrollElement` — the Provider has to be an ANCESTOR of the component that
 * calls the hook, not a descendant, or the hook would see the default
 * (`scrollElement: null`) context instead.
 */
function renderHarness() {
  function Root() {
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
    return (
      <div
        data-testid="scroller"
        ref={(node) => {
          if (node && node !== scrollElement) {
            setScrollElement(node);
          }
        }}
      >
        <HistoryScrollContext.Provider
          value={{
            scrollElement,
            registerScrollToNewest: () => {},
            registerScrollToDay: () => {},
            publishDayJumpState: () => {},
          }}
        >
          <Harness />
        </HistoryScrollContext.Provider>
      </div>
    );
  }
  render(<Root />);
  const scroller = screen.getByTestId("scroller") as HTMLDivElement;
  const timeline = screen.getByTestId("timeline") as HTMLDivElement;

  // jsdom has no layout engine: every rect it returns is hard zero and never
  // moves as `scrollTop` changes, unlike a real browser where a child pinned
  // at content-offset 0 reports `rect.top === -scrollTop`. Stubbed here so
  // this hook's `timelineTop = timelineRect.top - scrollerRect.top +
  // scrollElement.scrollTop` cancellation — real physics in a browser — also
  // holds in these tests, which is what `time-lanes.test.ts`'s own header
  // comment calls jsdom out for needing in the first place.
  Object.defineProperty(scroller, "getBoundingClientRect", {
    value: () => ({ top: 0 }) as DOMRect,
    configurable: true,
  });
  Object.defineProperty(timeline, "getBoundingClientRect", {
    value: () => ({ top: -scroller.scrollTop }) as DOMRect,
    configurable: true,
  });

  return scroller;
}

/**
 * A harness whose "timeline" node contains a nested `[data-time-scale]`
 * child, offset below it the way `comparative-timeline.tsx`'s `ScaleGutter`
 * sits below its own (sticky) `LaneHeading` — for the anchor-drift test
 * below, which needs that offset to exist at all to prove anything.
 */
function renderHarnessWithScaleOffset(headingHeightPx: number) {
  // Calls the hook, and is rendered INSIDE the Provider — see the plain
  // `renderHarness()` above's own comment on why the Provider has to be an
  // ancestor of whatever calls `useTimelineZoom`, not a component that
  // merely returns the Provider around itself.
  function Harness() {
    const zoom = useTimelineZoom();
    return (
      <div ref={zoom.timelineRef} data-testid="timeline" {...zoom.timelineProps}>
        <div data-testid="heading" />
        <div data-testid="scale" data-time-scale="" />
      </div>
    );
  }
  function Root() {
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
    return (
      <div
        data-testid="scroller"
        ref={(node) => {
          if (node && node !== scrollElement) {
            setScrollElement(node);
          }
        }}
      >
        <HistoryScrollContext.Provider
          value={{
            scrollElement,
            registerScrollToNewest: () => {},
            registerScrollToDay: () => {},
            publishDayJumpState: () => {},
          }}
        >
          <Harness />
        </HistoryScrollContext.Provider>
      </div>
    );
  }
  render(<Root />);
  const scroller = screen.getByTestId("scroller") as HTMLDivElement;
  const wrapper = screen.getByTestId("timeline") as HTMLDivElement;
  const scale = screen.getByTestId("scale") as HTMLDivElement;

  // Physically: the wrapper's own top coincides with the heading's (its
  // first child), and the scale sits `headingHeightPx` below that — a plain,
  // non-sticky sibling in normal flow, so this relationship holds regardless
  // of whether the heading is currently visually "stuck" (issue #418's own
  // fix comment has the longer version of this reasoning). Content-offset 0
  // for the wrapper, the same baseline the plain `renderHarness()` above
  // uses, so `-scroller.scrollTop` is the wrapper's own rect.
  Object.defineProperty(scroller, "getBoundingClientRect", {
    value: () => ({ top: 0 }) as DOMRect,
    configurable: true,
  });
  Object.defineProperty(wrapper, "getBoundingClientRect", {
    value: () => ({ top: -scroller.scrollTop }) as DOMRect,
    configurable: true,
  });
  Object.defineProperty(scale, "getBoundingClientRect", {
    value: () => ({ top: -scroller.scrollTop + headingHeightPx }) as DOMRect,
    configurable: true,
  });

  return scroller;
}

describe("useTimelineZoom", () => {
  it("starts at 120px/hour, the page's original fixed scale", () => {
    renderHarness();
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("120");
  });

  it("steps through ZOOM_LEVELS and disables at each end", () => {
    renderHarness();
    const zoomOut = screen.getByRole("button", { name: "zoom out" });
    const zoomIn = screen.getByRole("button", { name: "zoom in" });

    // 120 -> 30 is two steps out (240, 120, 60, 30 — index 2 to index 0).
    fireEvent.click(zoomOut);
    fireEvent.click(zoomOut);
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("30");
    expect(zoomOut).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("120");
    expect(zoomOut).toBeEnabled();

    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(zoomIn);
    }
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("3840");
    expect(zoomIn).toBeDisabled();
  });

  it("zooms in on '+' and '=' and out on '-' while the timeline has focus", () => {
    renderHarness();
    const timeline = screen.getByTestId("timeline");
    timeline.focus();

    fireEvent.keyDown(timeline, { key: "+" });
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("240");

    fireEvent.keyDown(timeline, { key: "-" });
    fireEvent.keyDown(timeline, { key: "-" });
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("60");

    fireEvent.keyDown(timeline, { key: "=" });
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("120");
  });

  it("marks the timeline pan-x pan-y so a browser pinch does not page-zoom instead", () => {
    renderHarness();
    expect(screen.getByTestId("timeline")).toHaveStyle({ touchAction: "pan-x pan-y" });
  });

  it("anchors the scroller after a keyboard zoom, keeping the centred instant fixed", () => {
    const scroller = renderHarness();
    // `clientHeight` is what `centerFocalOffset` reads; jsdom leaves layout
    // properties at 0 unless told otherwise, so this is stubbed rather than
    // relying on real geometry — the same limitation `time-lanes.test.ts`'s
    // own header comment documents.
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    scroller.scrollTop = 600;

    const timeline = screen.getByTestId("timeline");
    timeline.focus();
    fireEvent.keyDown(timeline, { key: "+" }); // 120 -> 240, doubling the scale height

    // focalOffset = clientHeight / 2 = 100. offsetWithinTimeline = 600 + 100
    // - 0 = 700, 700/2880 of the day, doubled to 1400 of the new 5760px
    // scale, then placed 100px below the focal point again: 1400 - 100 =
    // 1300 — the exact numbers `time-zoom.test.ts`'s own `anchoredScrollTop`
    // case already proves the formula for.
    expect(scroller.scrollTop).toBe(1300);
  });

  it("measures the scale itself, not the timeline wrapper, so a heading above it doesn't throw the anchor off", () => {
    // Issue #418: the anchor drifted ~20px (about 5 minutes at 120px/hour)
    // on every zoom step, compounding over repeated zooms, because
    // `timelineTop` was measured from the timeline WRAPPER's own top — which
    // sits one sticky `LaneHeading` higher than the scale (and so every
    // record) actually starts.
    const scroller = renderHarnessWithScaleOffset(20);
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    scroller.scrollTop = 600;

    const timeline = screen.getByTestId("timeline");
    timeline.focus();
    fireEvent.keyDown(timeline, { key: "+" }); // 120 -> 240, doubling the scale height

    // With the 20px heading correctly excluded: timelineTop = 20.
    // offsetWithinTimeline = 600 + 100 (focalOffset) - 20 = 680, 680/2880 of
    // the day, doubled to 1360 of the new 5760px scale, placed back 100px
    // below the focal point and 20px below the scale's own start again:
    // 1360 - 100 + 20 = 1280 — NOT 1300, which is what measuring the
    // wrapper (ignoring the heading) would give instead.
    expect(scroller.scrollTop).toBe(1280);
  });

  it("zooms in on a ctrl+wheel and applies the anchored scroll position", () => {
    const scroller = renderHarness();
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    scroller.scrollTop = 0;

    const timeline = screen.getByTestId("timeline");
    const wheel = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      clientY: 500,
      cancelable: true,
      bubbles: true,
    });
    // `fireEvent`, not a raw `.dispatchEvent()` — the listener is a hand-
    // attached native one (this hook's own header comment on why), and only
    // `fireEvent` wraps the dispatch in `act()` so the `setState` it
    // triggers is flushed before the assertions below read the DOM.
    const notPrevented = fireEvent(timeline, wheel);

    expect(notPrevented).toBe(false); // preventDefault() was actually called
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("240");
    // offsetWithinTimeline = 0 + 500 - 0 = 500 of the old 2880px scale,
    // doubled to 1000 of the new 5760px scale, placed back 500px below the
    // cursor: 1000 - 500 = 500.
    expect(scroller.scrollTop).toBe(500);
  });

  it("still zooms on ctrl+wheel when the timeline mounts after the hook does", () => {
    // The Time page calls the hook as soon as it renders but only draws the
    // timeline once a day's lanes have loaded, so the node the wheel listener
    // needs does not exist yet when the hook first runs.
    function LateTimeline() {
      const zoom = useTimelineZoom();
      const [loaded, setLoaded] = useState(false);
      return (
        <>
          <span data-testid="px-per-hour">{zoom.pxPerHour}</span>
          <button type="button" onClick={() => setLoaded(true)}>
            load
          </button>
          {loaded && <div ref={zoom.timelineRef} data-testid="timeline" {...zoom.timelineProps} />}
        </>
      );
    }
    render(<LateTimeline />);
    fireEvent.click(screen.getByRole("button", { name: "load" }));

    const wheel = new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, cancelable: true });
    const notPrevented = fireEvent(screen.getByTestId("timeline"), wheel);

    expect(notPrevented).toBe(false);
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("240");
  });

  it("ignores a plain wheel scroll — only a held modifier means zoom", () => {
    const scroller = renderHarness();
    scroller.scrollTop = 0;
    const timeline = screen.getByTestId("timeline");

    const wheel = new WheelEvent("wheel", {
      ctrlKey: false,
      deltaY: -100,
      cancelable: true,
      bubbles: true,
    });
    const notPrevented = fireEvent(timeline, wheel);

    expect(notPrevented).toBe(true);
    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("120");
  });

  it("steps zoom on a two-finger pinch, once the fingers move far enough apart", () => {
    renderHarness();
    const timeline = screen.getByTestId("timeline");

    fireEvent.pointerDown(timeline, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerDown(timeline, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 120,
      clientY: 100,
    });
    // Started 20px apart; spreading to 80px is a 4x change, well past the
    // 15% step threshold, so this must count as (at least) one zoom-in step.
    fireEvent.pointerMove(timeline, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 180,
      clientY: 100,
    });

    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("240");
  });

  it("does not treat a single-finger drag as a pinch", () => {
    renderHarness();
    const timeline = screen.getByTestId("timeline");

    fireEvent.pointerDown(timeline, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(timeline, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 300,
      clientY: 100,
    });

    expect(screen.getByTestId("px-per-hour")).toHaveTextContent("120");
  });
});
