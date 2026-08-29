import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardInset } from "./use-keyboard-inset";

/**
 * A stand-in for `window.visualViewport`, which jsdom does not implement.
 * Only the three members the hook reads are modelled, plus the listener
 * bookkeeping the unsubscribe test needs.
 */
class FakeVisualViewport implements EventTarget {
  height: number;
  offsetTop = 0;
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(height: number) {
    this.height = height;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
    return true;
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const originalInnerHeight = window.innerHeight;
const originalInnerWidth = window.innerWidth;

function setWindowSize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", {
    value: height,
    configurable: true,
    writable: true,
  });
}

function installViewport(height: number): FakeVisualViewport {
  const viewport = new FakeVisualViewport(height);
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
    writable: true,
  });
  return viewport;
}

function removeViewport() {
  Object.defineProperty(window, "visualViewport", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/** Fires the same event the real API fires when the keyboard animates in or out. */
function resizeViewport(viewport: FakeVisualViewport) {
  act(() => {
    viewport.dispatchEvent(new Event("resize"));
  });
}

afterEach(() => {
  setWindowSize(originalInnerWidth, originalInnerHeight);
  removeViewport();
  vi.restoreAllMocks();
});

describe("useKeyboardInset", () => {
  it("reports nothing when the engine has no visualViewport at all", () => {
    setWindowSize(390, 844);
    removeViewport();

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toEqual({ inset: 0, visible: false });
  });

  it("reports nothing while no keyboard is up", () => {
    setWindowSize(390, 844);
    installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    expect(result.current).toEqual({ inset: 0, visible: false });
  });

  // Chromium honouring interactive-widget=resizes-content: the layout
  // viewport shrinks along with the visual one, so layout has already made
  // room and the hook must not ask for it a second time.
  it("reports a visible keyboard but no residual inset when the engine resized the content", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    setWindowSize(390, 544);
    viewport.height = 544;
    resizeViewport(viewport);

    expect(result.current.visible).toBe(true);
    expect(result.current.inset).toBe(0);
  });

  // WKWebView, which ignores the interactive-widget key entirely: the layout
  // viewport is untouched and only the visual viewport shrinks, so the
  // keyboard is occluding 300px nothing has accounted for.
  it("reports the occluded height when the engine ignored interactive-widget", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    viewport.height = 544;
    resizeViewport(viewport);

    expect(result.current).toEqual({ inset: 300, visible: true });
  });

  it("subtracts the visual viewport's own offset, so a panned viewport is not mistaken for a keyboard", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    // The page is scrolled within the visual viewport: height drops but the
    // offset accounts for all of it, so nothing is actually occluded.
    viewport.height = 744;
    viewport.offsetTop = 100;
    resizeViewport(viewport);

    expect(result.current).toEqual({ inset: 0, visible: false });
  });

  it("ignores sub-threshold noise rather than shrinking the shell by a pixel", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    viewport.height = 841;
    resizeViewport(viewport);

    expect(result.current).toEqual({ inset: 0, visible: false });
  });

  it("returns to nothing once the keyboard closes again", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    viewport.height = 544;
    resizeViewport(viewport);
    expect(result.current.visible).toBe(true);

    viewport.height = 844;
    resizeViewport(viewport);

    expect(result.current).toEqual({ inset: 0, visible: false });
  });

  // A rotation changes the window's width and its height at once. Without a
  // reset, the taller portrait height stays the baseline and every landscape
  // frame reads as a keyboard that is permanently up.
  it("rebaselines on rotation instead of reading the shorter window as a keyboard", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    setWindowSize(844, 390);
    viewport.height = 390;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toEqual({ inset: 0, visible: false });
  });

  // Pins the limitation the hook's own doc comment records, so that changing
  // it is a deliberate act with a failing test behind it rather than a silent
  // behaviour drift. Rotating while the keyboard is already up reseeds the
  // baseline from an already-shrunk height, so on the engine that resizes
  // content there is no evidence left that a keyboard is there. `inset` is
  // unaffected, which is what keeps WKWebView correct regardless.
  it("cannot see a keyboard that was already open across a rotation (documented limitation)", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { result } = renderHook(() => useKeyboardInset());

    // Keyboard opens, Chromium-style: the layout viewport shrinks with it.
    setWindowSize(390, 544);
    viewport.height = 544;
    resizeViewport(viewport);
    expect(result.current.visible).toBe(true);

    // Rotate to landscape with the keyboard still up. The width changed, so
    // the baseline resets — to a height the keyboard is already taking from.
    setWindowSize(844, 300);
    viewport.height = 300;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toEqual({ inset: 0, visible: false });

    // ...and it heals as soon as the keyboard closes and the baseline grows.
    setWindowSize(844, 390);
    viewport.height = 390;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toEqual({ inset: 0, visible: false });

    setWindowSize(844, 300);
    viewport.height = 300;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.visible).toBe(true);
  });

  it("stops listening when it unmounts", () => {
    setWindowSize(390, 844);
    const viewport = installViewport(844);

    const { unmount } = renderHook(() => useKeyboardInset());
    expect(viewport.listenerCount("resize")).toBeGreaterThan(0);

    unmount();

    expect(viewport.listenerCount("resize")).toBe(0);
    expect(viewport.listenerCount("scroll")).toBe(0);
  });
});
