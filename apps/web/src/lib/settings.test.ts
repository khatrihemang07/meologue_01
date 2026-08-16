import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normaliseServerUrl, useSettingsStore } from "./settings";

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: "system", serverUrl: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("theme", () => {
    it("round-trips a written theme, in the store and in storage", () => {
      useSettingsStore.getState().setTheme("dark");

      expect(useSettingsStore.getState().theme).toBe("dark");
      expect(localStorage.getItem("meologue.theme")).toBe("dark");
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => useSettingsStore.getState().setTheme("dark")).not.toThrow();
      expect(useSettingsStore.getState().theme).toBe("dark");
    });
  });

  describe("server URL", () => {
    it("round-trips a written server URL, in the store and in storage", () => {
      useSettingsStore.getState().setServerUrl("https://phone.example:41207");

      expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
      expect(localStorage.getItem("meologue.server-url")).toBe("https://phone.example:41207");
    });

    it("defaults to empty", () => {
      expect(useSettingsStore.getState().serverUrl).toBe("");
    });

    it("normalises before storing: trims whitespace and strips exactly one trailing slash", () => {
      useSettingsStore.getState().setServerUrl("  https://phone.example:41207///  ");

      expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207//");
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() =>
        useSettingsStore.getState().setServerUrl("https://phone.example:41207"),
      ).not.toThrow();
      expect(useSettingsStore.getState().serverUrl).toBe("https://phone.example:41207");
    });
  });

  describe("normaliseServerUrl", () => {
    it("trims surrounding whitespace", () => {
      expect(normaliseServerUrl("  https://phone.example:41207  ")).toBe(
        "https://phone.example:41207",
      );
    });

    it("strips exactly one trailing slash", () => {
      expect(normaliseServerUrl("https://phone.example:41207///")).toBe(
        "https://phone.example:41207//",
      );
    });
  });
});

// Cold-start defaulting happens once, at module load, so it's exercised
// against a fresh module instance rather than the shared singleton above —
// by the time any test runs, that singleton already picked its initial
// value.
describe("settings store cold start", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("defaults theme to system when nothing is stored", async () => {
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().theme).toBe("system");
  });

  it("defaults theme to system for an unrecognised stored value", async () => {
    localStorage.setItem("meologue.theme", "solarized");
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().theme).toBe("system");
  });

  it("defaults theme to system when localStorage throws on read", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().theme).toBe("system");
  });

  it("picks up an already-stored theme", async () => {
    localStorage.setItem("meologue.theme", "dark");
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().theme).toBe("dark");
  });

  it("defaults the server URL to empty when nothing is stored", async () => {
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().serverUrl).toBe("");
  });

  it("defaults the server URL to empty when localStorage throws on read", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().serverUrl).toBe("");
  });

  it("picks up an already-stored server URL", async () => {
    localStorage.setItem("meologue.server-url", "https://phone.example:41207");
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().serverUrl).toBe("https://phone.example:41207");
  });
});
