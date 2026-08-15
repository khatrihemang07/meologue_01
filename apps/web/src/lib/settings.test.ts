import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readServerUrl, readTheme, resolveServerUrl, writeServerUrl, writeTheme } from "./settings";

describe("settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("theme", () => {
    it("round-trips a written theme", () => {
      writeTheme("dark");
      expect(readTheme()).toBe("dark");
    });

    it("defaults to system when nothing is stored", () => {
      expect(readTheme()).toBe("system");
    });

    it("defaults to system for an unrecognised stored value", () => {
      localStorage.setItem("meologue.theme", "solarized");
      expect(readTheme()).toBe("system");
    });

    it("degrades to system when localStorage throws on read", () => {
      vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(readTheme()).toBe("system");
    });

    it("does not throw when localStorage refuses the write", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => writeTheme("dark")).not.toThrow();
    });
  });

  describe("server URL", () => {
    it("round-trips a written server URL", () => {
      writeServerUrl("https://phone.example:41207");
      expect(readServerUrl()).toBe("https://phone.example:41207");
    });

    it("defaults to empty when nothing is stored", () => {
      expect(readServerUrl()).toBe("");
    });

    it("trims surrounding whitespace", () => {
      writeServerUrl("  https://phone.example:41207  ");
      expect(readServerUrl()).toBe("https://phone.example:41207");
    });

    it("strips exactly one trailing slash", () => {
      writeServerUrl("https://phone.example:41207///");
      expect(readServerUrl()).toBe("https://phone.example:41207//");
    });

    it("degrades to empty when localStorage throws on read", () => {
      vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(readServerUrl()).toBe("");
    });

    it("does not throw when localStorage refuses the write", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => writeServerUrl("https://phone.example:41207")).not.toThrow();
    });
  });

  describe("resolveServerUrl", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("prefers the given (stored) value over VITE_SERVER_URL", () => {
      vi.stubEnv("VITE_SERVER_URL", "https://built-in.example");
      expect(resolveServerUrl("https://stored.example")).toBe("https://stored.example");
    });

    it("falls back to VITE_SERVER_URL when the given value is empty", () => {
      vi.stubEnv("VITE_SERVER_URL", "https://built-in.example");
      expect(resolveServerUrl("")).toBe("https://built-in.example");
    });

    it("falls back to empty (same-origin) when neither is set", () => {
      expect(resolveServerUrl("")).toBe("");
    });
  });
});
