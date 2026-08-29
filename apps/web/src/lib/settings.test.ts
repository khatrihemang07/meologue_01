import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_TEXT_SIZE,
  normaliseServerUrl,
  TEXT_SIZES,
  useSettingsStore,
} from "./settings";

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      theme: "system",
      serverUrl: "",
      accent: DEFAULT_ACCENT,
      textSize: DEFAULT_TEXT_SIZE,
    });
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

  // #128. Both are per-Device view preferences, the same category as theme
  // and the list width — never Synced, and never in the glossary.
  describe("accent", () => {
    it("round-trips a written accent, in the store and in storage", () => {
      useSettingsStore.getState().setAccent("violet");

      expect(useSettingsStore.getState().accent).toBe("violet");
      expect(localStorage.getItem("meologue.accent")).toBe("violet");
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => useSettingsStore.getState().setAccent("teal")).not.toThrow();
      expect(useSettingsStore.getState().accent).toBe("teal");
    });

    it("offers five accents, with unique ids", () => {
      // Five is what the grid in Settings lays out without orphaning one
      // onto a row of its own — see `ChoiceRow`'s own comment.
      expect(ACCENTS).toHaveLength(5);
      expect(new Set(ACCENTS.map((accent) => accent.id)).size).toBe(5);
    });

    it("ignores a stored id it does not recognise, rather than applying it", () => {
      // An id from a different version of this app, or a hand-edited value:
      // `index.css` has no rule for it, so applying it would leave the
      // thread with no fill at all rather than a colour.
      localStorage.setItem("meologue.accent", "chartreuse");
      localStorage.setItem("meologue.text-size", "enormous");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().accent).toBe(fresh.DEFAULT_ACCENT);
        expect(fresh.useSettingsStore.getState().textSize).toBe(fresh.DEFAULT_TEXT_SIZE);
      });
    });

    it("reads a stored id back at load", () => {
      localStorage.setItem("meologue.accent", "violet");
      localStorage.setItem("meologue.text-size", "large");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().accent).toBe("violet");
        expect(fresh.useSettingsStore.getState().textSize).toBe("large");
      });
    });

    it("defaults to something other than the neutral one", () => {
      // Graphite would preserve exactly the near-grey-on-near-grey a
      // Question and its Answer were told apart by before this existed,
      // which is the defect the Accent is here to fix.
      expect(DEFAULT_ACCENT).not.toBe("graphite");
      expect(ACCENTS.map((accent) => accent.id)).toContain(DEFAULT_ACCENT);
    });
  });

  describe("text size", () => {
    it("round-trips a written text size, in the store and in storage", () => {
      useSettingsStore.getState().setTextSize("large");

      expect(useSettingsStore.getState().textSize).toBe("large");
      expect(localStorage.getItem("meologue.text-size")).toBe("large");
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => useSettingsStore.getState().setTextSize("small")).not.toThrow();
      expect(useSettingsStore.getState().textSize).toBe("small");
    });

    it("offers three sizes, with the default among them", () => {
      expect(TEXT_SIZES.map((size) => size.id)).toEqual(["small", "default", "large"]);
      expect(TEXT_SIZES.map((size) => size.id)).toContain(DEFAULT_TEXT_SIZE);
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
