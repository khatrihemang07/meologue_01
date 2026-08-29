import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWideLayout, WIDE_LAYOUT_QUERY } from "./use-wide-layout";

/** Minimal MediaQueryList stand-in — jsdom implements no matchMedia at all. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: initial,
    media: WIDE_LAYOUT_QUERY,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  };
  const matchMedia = vi.fn(() => query);
  Object.defineProperty(window, "matchMedia", {
    value: matchMedia,
    configurable: true,
    writable: true,
  });
  return {
    query,
    listenerCount: () => listeners.size,
    change(matches: boolean) {
      query.matches = matches;
      act(() => {
        for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
      });
    },
  };
}

function removeMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  removeMatchMedia();
  vi.restoreAllMocks();
});

describe("useWideLayout", () => {
  it("reads the query synchronously on mount", () => {
    installMatchMedia(true);

    const { result } = renderHook(() => useWideLayout());

    expect(result.current).toBe(true);
  });

  it("is narrow when the query does not match", () => {
    installMatchMedia(false);

    const { result } = renderHook(() => useWideLayout());

    expect(result.current).toBe(false);
  });

  it("follows the query changing after mount", () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useWideLayout());

    media.change(true);

    expect(result.current).toBe(true);
  });

  // The cold-landscape case the double rAF exists for: the first synchronous
  // read answers narrow because the viewport has not settled, and the
  // re-ask two frames later is what corrects it.
  it("corrects itself after two frames when the first read was wrong", async () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useWideLayout());
    expect(result.current).toBe(false);

    media.query.matches = true;
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });

    expect(result.current).toBe(true);
  });

  it("degrades to narrow when the engine has no matchMedia", () => {
    removeMatchMedia();

    const { result } = renderHook(() => useWideLayout());

    expect(result.current).toBe(false);
  });

  it("stops listening when it unmounts", () => {
    const media = installMatchMedia(true);
    const { unmount } = renderHook(() => useWideLayout());
    expect(media.listenerCount()).toBe(1);

    unmount();

    expect(media.listenerCount()).toBe(0);
  });
});
