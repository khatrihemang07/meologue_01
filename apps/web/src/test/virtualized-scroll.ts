import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Gives `@tanstack/react-virtual` a real, measured viewport under jsdom.
 *
 * jsdom lays nothing out (history.tsx's own comment on its `measureElement`
 * override) and implements no `ResizeObserver` at all — every element's
 * `offsetWidth`/`offsetHeight` reads `0`, forever, with nothing to notify
 * a listener otherwise. `@tanstack/react-virtual`'s own `observeElementRect`
 * (virtual-core) reads exactly those two properties off the scroll element
 * (not `getBoundingClientRect`, not `clientHeight`/`scrollHeight` — those
 * back `usePinnedScroll`'s own pin math, a distinct concern; see
 * shell.test.tsx's/use-pinned-scroll.test.tsx's own `setScrollGeometry`),
 * once synchronously the moment it subscribes to the scroll element, and
 * from then on only in response to a real `ResizeObserver` callback. With
 * no `ResizeObserver` in jsdom, that one synchronous read — always `{width:
 * 0, height: 0}` — is the only measurement the virtualizer ever gets, which
 * is what keeps `virtualizer.range` permanently `null` in every plain jsdom
 * render (`calculateRange`, virtual-core: `outerSize === 0` always bails
 * out to `null`, regardless of how many rows there are to measure).
 *
 * This pair of helpers breaks that deadlock the same way a real browser's
 * ResizeObserver would, deliberately split into "what size is this element"
 * and "tell the virtualizer to look again" so a test can do the first
 * — `stubOffsetSize` — at whatever point it likes (mount, or later, once
 * it holds the real scroll element), and the second — the `triggerResize`
 * this returns — only when it actually wants the virtualizer to re-measure,
 * mirroring a real resize notification arriving asynchronously after the
 * element already exists.
 *
 * `installResizeObserverStub` replaces the global `ResizeObserver` via
 * `vi.stubGlobal`, so the caller's own `afterEach(() => vi.unstubAllGlobals())`
 * (every test file that touches `ResizeObserver` in this codebase already has
 * one — see use-pinned-scroll.test.tsx's own) is what actually restores it;
 * this installs nothing that cleans itself up on its own. It installs a
 * stand-in that records which targets each constructed instance observes,
 * the same capture-the-callback idea use-pinned-scroll.test.tsx's own
 * `notifyResize` already uses for a single hook's resize reaction, gener-
 * alised here to (potentially) several instances — `@tanstack/react-virtual`
 * constructs one for the scroll element (`observeElementRect`) and a second
 * for every individually-measured row (`Virtualizer`'s own `this.observer`).
 * `triggerResize` fires only the instance(s) actually observing the given
 * target, with a synthetic entry that carries no `borderBoxSize` — which is
 * what sends `observeElementRect`'s own handler down its
 * `handler(getRect(element))` fallback branch, re-reading `offsetWidth`/
 * `offsetHeight` off the live element at the moment this fires, rather than
 * trusting a size this stub never actually computed.
 */
export function installResizeObserverStub(): {
  triggerResize: (target: Element) => void;
} {
  const instances: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];

  class StubResizeObserver implements ResizeObserver {
    #entry: { callback: ResizeObserverCallback; targets: Set<Element> };

    constructor(callback: ResizeObserverCallback) {
      this.#entry = { callback, targets: new Set() };
      instances.push(this.#entry);
    }

    observe(target: Element): void {
      this.#entry.targets.add(target);
    }

    unobserve(target: Element): void {
      this.#entry.targets.delete(target);
    }

    disconnect(): void {
      this.#entry.targets.clear();
    }
  }

  vi.stubGlobal("ResizeObserver", StubResizeObserver);

  return {
    triggerResize(target: Element) {
      act(() => {
        for (const { callback, targets } of instances) {
          if (!targets.has(target)) {
            continue;
          }
          const entry = { target } as ResizeObserverEntry;
          callback([entry], undefined as unknown as ResizeObserver);
        }
      });
    },
  };
}

/**
 * Sets `el`'s own `offsetWidth`/`offsetHeight` — see this module's own
 * header comment for exactly which two properties that is, and why those
 * and not `getBoundingClientRect`/`clientHeight`/`scrollHeight`. Defined on
 * the element instance itself (`configurable: true`, so a later call can
 * redefine it, e.g. after a resize), not on a prototype — this never leaks
 * to any other element or any other test.
 */
export function stubOffsetSize(el: Element, { width = 400, height = 400 } = {}): void {
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: height, configurable: true });
}
