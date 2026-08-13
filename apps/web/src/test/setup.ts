import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
