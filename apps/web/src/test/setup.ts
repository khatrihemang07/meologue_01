import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// Node 22+'s own experimental global `localStorage` (see `--localstorage-file`
// in `node --help`) is already installed on `globalThis` before jsdom's
// environment ever runs, and vitest's environment setup skips copying a key
// from jsdom's `window` that already exists on the global object — so
// jsdom's real `localStorage` never gets a chance to install itself, and
// accessing the Node one throws/warns without `--localstorage-file`. A tiny
// in-memory Storage stand-in restores the browser API `settings.ts` (and its
// tests) depend on, independent of Node version or CLI flags.
class MemoryStorage implements Storage {
  #data = new Map<string, string>();

  get length(): number {
    return this.#data.size;
  }

  clear(): void {
    this.#data.clear();
  }

  getItem(key: string): string | null {
    return this.#data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});

afterEach(() => {
  cleanup();
});

// jsdom implements no `window.matchMedia` at all, which `hoverCapable()`
// (lib/pointer.ts) reads as "not hover-capable" — the same reading a real
// touch device gives. Left unstubbed (issue #213), every jsdom test would
// silently start rendering the Composer's touch toolbar and
// `formatBarVisible` would start defaulting on, for reasons that have
// nothing to do with what that particular test is about. Stubbed here, once
// before every test, to the more common jsdom case (a pointer device) so
// existing tests keep exercising pointer-shaped behaviour without each
// having to know to stub it themselves; only `(hover: hover)` answers
// `true` — every other query (reduced-motion, prefers-color-scheme, the
// wide-layout breakpoint, ...) answers `false`, matching what each of THOSE
// already got from `typeof window.matchMedia === "function"` being false
// pre-#213, so this changes nothing for tests that were never about hover
// in the first place. A test that wants the touch case (or a specific
// answer for some other query) stubs `matchMedia` itself — same pattern
// `entry-actions.test.tsx`'s own `stubHoverCapable` and this repo's other
// per-file matchMedia stand-ins already use — and `vi.unstubAllGlobals()`
// in that test's own `afterEach` clears it before this hook re-stubs the
// default ahead of the next test.
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(hover: hover)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

/**
 * jsdom implements no `ResizeObserver` at all (`@/test/virtualized-
 * scroll.ts`'s own header comment). A handful of components (task-
 * schedule-popover.tsx, use-pinned-scroll.ts, digest-page.tsx) construct
 * one unconditionally as soon as they mount the element they observe —
 * not behind a feature check, since every real browser this app ships to
 * has one — so without a stand-in, a plain jsdom render throws the moment
 * any of those code paths runs, for reasons that have nothing to do with
 * what a given test is actually about (issue #440's own defect fix is what
 * surfaced this: task-schedule-popover.tsx's desktop popover didn't
 * construct one before that fix, and every test anywhere that opens it —
 * dozens of files, not just its own — started throwing). A no-op default,
 * same as `matchMedia` above: a test that actually wants to fire a resize
 * callback replaces this with `@/test/virtualized-scroll`'s own
 * `installResizeObserverStub()`, which tracks observed targets and can
 * trigger them — this one exists only so the constructor itself, and
 * `observe`/`unobserve`/`disconnect`, never throw.
 */
class NoOpResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoOpResizeObserver);
});
