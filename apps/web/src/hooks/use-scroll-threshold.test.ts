import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScrollThreshold } from "./use-scroll-threshold";

/** jsdom lays nothing out, so `scrollTop` is a plain writable property here — the same technique shell.test.tsx's own `setScrollGeometry` uses. */
function setScrollTop(el: HTMLElement, value: number) {
  Object.defineProperty(el, "scrollTop", { value, configurable: true, writable: true });
}

describe("useScrollThreshold — issue #437's mini-title/sticky-header trigger", () => {
  it("reads false before a scroll region exists (element is null)", () => {
    const { result } = renderHook(() => useScrollThreshold(null, 34));
    expect(result.current).toBe(false);
  });

  it("reads the element's current scrollTop synchronously against the threshold on mount, not only after a later scroll event", () => {
    const el = document.createElement("div");
    setScrollTop(el, 40);

    const { result } = renderHook(() => useScrollThreshold(el, 34));

    expect(result.current).toBe(true);
  });

  it("flips true the instant scrollTop reaches the threshold, and false again the instant it drops below — no debounce, no transition state", () => {
    const el = document.createElement("div");
    setScrollTop(el, 0);
    const { result } = renderHook(() => useScrollThreshold(el, 34));
    expect(result.current).toBe(false);

    act(() => {
      setScrollTop(el, 34);
      fireEvent.scroll(el);
    });
    expect(result.current).toBe(true);

    act(() => {
      setScrollTop(el, 33);
      fireEvent.scroll(el);
    });
    expect(result.current).toBe(false);
  });

  it("uses >= , not >: exactly at the threshold already counts as past it", () => {
    const el = document.createElement("div");
    setScrollTop(el, 0);
    const { result } = renderHook(() => useScrollThreshold(el, 84));

    act(() => {
      setScrollTop(el, 84);
      fireEvent.scroll(el);
    });

    expect(result.current).toBe(true);
  });

  it("a different threshold on the same element is independent — Overdue's 84px and the mini title's 34px never share state", () => {
    const el = document.createElement("div");
    setScrollTop(el, 50);

    const mini = renderHook(() => useScrollThreshold(el, 34));
    const overdue = renderHook(() => useScrollThreshold(el, 84));

    expect(mini.result.current).toBe(true);
    expect(overdue.result.current).toBe(false);
  });

  it("stops listening once the element unmounts/changes — no leaked listener firing state updates on a stale element", () => {
    const el = document.createElement("div");
    setScrollTop(el, 0);
    const { result, rerender } = renderHook(({ element }) => useScrollThreshold(element, 34), {
      initialProps: { element: el as HTMLElement | null },
    });
    expect(result.current).toBe(false);

    rerender({ element: null });
    expect(result.current).toBe(false);

    // The old element scrolling past the threshold after being swapped out
    // must not resurrect a state update through a detached listener.
    act(() => {
      setScrollTop(el, 100);
      fireEvent.scroll(el);
    });
    expect(result.current).toBe(false);
  });
});
