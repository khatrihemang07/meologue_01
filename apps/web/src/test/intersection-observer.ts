import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * jsdom implements no `IntersectionObserver` at all — `test/setup.ts`'s own
 * file-wide `NoOpIntersectionObserver` keeps the constructor (and
 * `observe`/`unobserve`/`disconnect`) from throwing everywhere by default,
 * the identical split `@/test/virtualized-scroll`'s own
 * `installResizeObserverStub` already uses for `ResizeObserver`: a silent
 * no-op for every test that never fires one, and this stand-in — installed
 * on top of that default, for the duration of one test — for the tests
 * that actually want to drive a callback.
 *
 * `trigger` delivers a synthetic entry carrying only `target`/
 * `isIntersecting` — use-scrolled-under-bar.ts's own callback reads
 * nothing else off the entry, so this never needs to fabricate a real
 * `boundingClientRect`/`rootBounds` jsdom couldn't measure honestly
 * anyway.
 */
export function installIntersectionObserverStub(): {
  trigger: (target: Element, isIntersecting: boolean) => void;
} {
  const instances: Array<{ callback: IntersectionObserverCallback; targets: Set<Element> }> = [];

  class StubIntersectionObserver implements IntersectionObserver {
    root: Element | Document | null = null;
    rootMargin = "";
    scrollMargin = "";
    thresholds: ReadonlyArray<number> = [];
    #entry: { callback: IntersectionObserverCallback; targets: Set<Element> };

    constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
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

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);

  return {
    trigger(target: Element, isIntersecting: boolean) {
      act(() => {
        for (const { callback, targets } of instances) {
          if (!targets.has(target)) {
            continue;
          }
          const entry = { target, isIntersecting } as IntersectionObserverEntry;
          callback([entry], undefined as unknown as IntersectionObserver);
        }
      });
    },
  };
}
