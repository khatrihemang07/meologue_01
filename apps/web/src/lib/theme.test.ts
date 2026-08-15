import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "./settings";
import { applyTheme, watchSystemTheme } from "./theme";

/** Stands in for `matchMedia("(prefers-color-scheme: dark)")` with a
 * controllable `matches` and a `change` listener the test can fire. */
function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const mediaQueryList = {
    matches: initialMatches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
  };

  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQueryList),
  );

  return {
    fireChange(nextMatches: boolean) {
      mediaQueryList.matches = nextMatches;
      for (const listener of listeners) {
        listener({ matches: nextMatches });
      }
    },
  };
}

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("applyTheme", () => {
    it("adds the dark class for 'dark'", () => {
      stubMatchMedia(false);
      applyTheme("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("removes the dark class for 'light'", () => {
      stubMatchMedia(true);
      document.documentElement.classList.add("dark");
      applyTheme("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("resolves 'system' to dark when the OS prefers dark", () => {
      stubMatchMedia(true);
      applyTheme("system");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("resolves 'system' to light when the OS prefers light", () => {
      stubMatchMedia(false);
      applyTheme("system");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });

  describe("watchSystemTheme", () => {
    it("re-applies the OS preference when the stored theme is 'system'", () => {
      const media = stubMatchMedia(false);
      useSettingsStore.getState().setTheme("system");
      watchSystemTheme();

      media.fireChange(true);

      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("is a no-op when the stored theme is an explicit light/dark", () => {
      const media = stubMatchMedia(false);
      useSettingsStore.getState().setTheme("light");
      watchSystemTheme();
      document.documentElement.classList.remove("dark");

      media.fireChange(true);

      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });
});
