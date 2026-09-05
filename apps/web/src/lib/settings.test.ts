import { PROTOCOL_VERSION } from "@meologue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCENTS,
  COMPLETED_STYLES,
  DEFAULT_ACCENT,
  DEFAULT_COMPLETED_STYLE,
  DEFAULT_HIDDEN_DESTINATIONS,
  DEFAULT_REFLECT_MODEL,
  DEFAULT_SMART_DATES_ENABLED,
  DEFAULT_TEXT_SIZE,
  HIDEABLE_DESTINATIONS,
  normaliseServerUrl,
  refreshCapabilities,
  TEXT_SIZES,
  useSettingsStore,
} from "./settings";

function healthResponse(capabilities?: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      service: "meologue-server",
      protocol_version: PROTOCOL_VERSION,
      ...(capabilities !== undefined ? { capabilities } : {}),
    }),
  };
}

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      theme: "system",
      serverUrl: "",
      accent: DEFAULT_ACCENT,
      textSize: DEFAULT_TEXT_SIZE,
      completedStyle: DEFAULT_COMPLETED_STYLE,
      capabilities: null,
      serverReachable: true,
      hiddenDestinations: DEFAULT_HIDDEN_DESTINATIONS,
      defaultReflectModel: DEFAULT_REFLECT_MODEL,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  // Issue #163. Display only — the acceptance criteria this whole block
  // proves are "persists across a restart, per-key" and "defaults to
  // grayed out"; "changes no Entry, Syncs nothing" needs no test here
  // because setCompletedStyle never touches the Entry store or a sync
  // transport at all — there's nothing wired up for it to call.
  describe("completed checklist item style", () => {
    it("round-trips a written style, in the store and in storage", () => {
      useSettingsStore.getState().setCompletedStyle("grayAndStrike");

      expect(useSettingsStore.getState().completedStyle).toBe("grayAndStrike");
      expect(localStorage.getItem("meologue.completed-style")).toBe("grayAndStrike");
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => useSettingsStore.getState().setCompletedStyle("none")).not.toThrow();
      expect(useSettingsStore.getState().completedStyle).toBe("none");
    });

    it("offers four styles, with the default among them", () => {
      expect(COMPLETED_STYLES.map((style) => style.id)).toEqual([
        "grayAndStrike",
        "gray",
        "strike",
        "none",
      ]);
      expect(COMPLETED_STYLES.map((style) => style.id)).toContain(DEFAULT_COMPLETED_STYLE);
    });

    // UpNote's own default, per the ticket this setting was built for.
    it("defaults to grayed out, matching UpNote", () => {
      expect(DEFAULT_COMPLETED_STYLE).toBe("gray");
    });

    it("ignores a stored id it does not recognise, rather than applying it", () => {
      localStorage.setItem("meologue.completed-style", "highlighted");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().completedStyle).toBe(
          fresh.DEFAULT_COMPLETED_STYLE,
        );
      });
    });

    it("reads a stored id back at load", () => {
      localStorage.setItem("meologue.completed-style", "strike");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().completedStyle).toBe("strike");
      });
    });
  });

  // Issue #170.
  describe("smart date recognition", () => {
    it("round-trips a written value, in the store and in storage", () => {
      useSettingsStore.getState().setSmartDatesEnabled(false);

      expect(useSettingsStore.getState().smartDatesEnabled).toBe(false);
      expect(localStorage.getItem("meologue.smart-dates-enabled")).toBe("false");
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() => useSettingsStore.getState().setSmartDatesEnabled(false)).not.toThrow();
      expect(useSettingsStore.getState().smartDatesEnabled).toBe(false);
    });

    it("defaults to on, matching QuickAddOptions.smartDates' own default", () => {
      expect(DEFAULT_SMART_DATES_ENABLED).toBe(true);
    });

    it("reads a stored 'false' back at load", () => {
      localStorage.setItem("meologue.smart-dates-enabled", "false");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().smartDatesEnabled).toBe(false);
      });
    });

    // Mirrors formatBarVisible's own convention (settings.ts's
    // readStoredFormatBarVisible doc comment): a boolean has no finite id
    // list to validate a stored value against, so anything other than the
    // exact string "true" — no key at all, or a hand-edited/corrupt one —
    // degrades to the same default this setting already has.
    it("treats a hand-edited value that isn't 'true' as off, not as a parse error", () => {
      localStorage.setItem("meologue.smart-dates-enabled", "yes-please");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().smartDatesEnabled).toBe(false);
      });
    });

    it("degrades to the default when localStorage throws on read", () => {
      vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().smartDatesEnabled).toBe(
          fresh.DEFAULT_SMART_DATES_ENABLED,
        );
      });
    });
  });

  // Issue #202: the Device-local default `question-composer.tsx`'s picker
  // pre-selects a fresh Conversation on.
  describe("default Reflect model", () => {
    it("round-trips a written value, in the store and in storage", () => {
      useSettingsStore.getState().setDefaultReflectModel("claude-sonnet");

      expect(useSettingsStore.getState().defaultReflectModel).toBe("claude-sonnet");
      expect(localStorage.getItem("meologue.default-reflect-model")).toBe("claude-sonnet");
    });

    it("defaults to '' — Server default, matching the picker's own sentinel", () => {
      expect(useSettingsStore.getState().defaultReflectModel).toBe("");
      expect(DEFAULT_REFLECT_MODEL).toBe("");
    });

    // Mirrors "hidden destinations"'s own convention below: no key at all
    // for "nothing chosen," so a reader who picks a default and clears it
    // back to Server default leaves no trace in storage, indistinguishable
    // from a Device that never touched this setting.
    it("removes the stored key entirely once cleared back to Server default", () => {
      useSettingsStore.getState().setDefaultReflectModel("claude-sonnet");
      expect(localStorage.getItem("meologue.default-reflect-model")).not.toBeNull();

      useSettingsStore.getState().setDefaultReflectModel("");

      expect(localStorage.getItem("meologue.default-reflect-model")).toBeNull();
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() =>
        useSettingsStore.getState().setDefaultReflectModel("claude-sonnet"),
      ).not.toThrow();
      expect(useSettingsStore.getState().defaultReflectModel).toBe("claude-sonnet");
    });

    it("reads a stored value back at load, with no validation against a known model list", () => {
      // Deliberately an id no fixture model list here ever offers — the
      // Server's own list is fetched at runtime and this module's read is
      // synchronous, so there is nothing to validate against (settings.ts's
      // own doc comment on `DEFAULT_REFLECT_MODEL`).
      localStorage.setItem(
        "meologue.default-reflect-model",
        "a-model-this-build-has-never-heard-of",
      );

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().defaultReflectModel).toBe(
          "a-model-this-build-has-never-heard-of",
        );
      });
    });

    it("degrades to the default when localStorage throws on read", () => {
      vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().defaultReflectModel).toBe(
          fresh.DEFAULT_REFLECT_MODEL,
        );
      });
    });
  });

  // Issue #134.
  describe("hidden destinations", () => {
    it("round-trips a written set, in the store and in storage", () => {
      useSettingsStore.getState().setHiddenDestinations(new Set(["reflect", "digest"]));

      expect(useSettingsStore.getState().hiddenDestinations).toEqual(
        new Set(["reflect", "digest"]),
      );
      // Comma-joined, not JSON — ADR 0008's own reasoning, restated at the
      // top of settings.ts beside `HIDDEN_DESTINATIONS_KEY`.
      expect(localStorage.getItem("meologue.hidden-destinations")).toBe("reflect,digest");
    });

    it("defaults to nothing hidden — every Destination visible", () => {
      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set());
      expect(DEFAULT_HIDDEN_DESTINATIONS).toEqual(new Set());
    });

    it("removes the stored key entirely once every Destination is unhidden again", () => {
      useSettingsStore.getState().setHiddenDestinations(new Set(["composer"]));
      expect(localStorage.getItem("meologue.hidden-destinations")).not.toBeNull();

      useSettingsStore.getState().setHiddenDestinations(new Set());

      expect(localStorage.getItem("meologue.hidden-destinations")).toBeNull();
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      expect(() =>
        useSettingsStore.getState().setHiddenDestinations(new Set(["digest"])),
      ).not.toThrow();
      expect(useSettingsStore.getState().hiddenDestinations).toEqual(new Set(["digest"]));
    });

    it("offers exactly the four hideable Destinations — Settings is never among them", () => {
      expect(HIDEABLE_DESTINATIONS.map((destination) => destination.id)).toEqual([
        "composer",
        "reflect",
        "digest",
        "todo",
      ]);
    });

    // Required (issue #134): a corrupt/unreadable value degrades to
    // everything visible, and an unrecognised slug is ignored rather than
    // thrown on — both exercised at module load, since that's where
    // `readStoredHiddenDestinations` actually runs (mirrors the
    // "accent"/"text size" `vi.resetModules` tests above).
    it("degrades to everything visible when localStorage throws on read", () => {
      localStorage.setItem("meologue.hidden-destinations", "reflect");
      vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().hiddenDestinations).toEqual(new Set());
      });
    });

    it("ignores an unrecognised slug in the stored string rather than throwing", () => {
      // "history" is a real route this app once had (issue #75 deleted it)
      // and is exactly the kind of slug a previous app version could still
      // leave behind — mixed here with a slug this build does recognise, so
      // the good one surviving proves this drops one at a time rather than
      // discarding the whole value the way a failed `JSON.parse` would.
      localStorage.setItem("meologue.hidden-destinations", "history,digest");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().hiddenDestinations).toEqual(new Set(["digest"]));
      });
    });

    it("ignores 'settings' even if it appears in a hand-edited stored value", () => {
      // Settings can never be hidden (ADR 0008/0009). It is never offered a
      // control to add itself to this value, but a stored value can be
      // edited by hand or carried over from a future build, so this is
      // enforced on read too, not only by the absence of a control.
      localStorage.setItem("meologue.hidden-destinations", "settings,composer");

      vi.resetModules();
      return import("./settings").then((fresh) => {
        expect(fresh.useSettingsStore.getState().hiddenDestinations).toEqual(new Set(["composer"]));
      });
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

  // Issue #133.
  describe("capabilities", () => {
    it("round-trips a written capability report, in the store and in storage", () => {
      const capabilities = { reflect: true, digest: false, embeddings: true, todo: true };

      useSettingsStore.getState().setCapabilities(capabilities);

      expect(useSettingsStore.getState().capabilities).toEqual(capabilities);
      expect(JSON.parse(localStorage.getItem("meologue.capabilities") ?? "null")).toEqual(
        capabilities,
      );
    });

    it("clears the stored report when set back to null (unknown)", () => {
      useSettingsStore
        .getState()
        .setCapabilities({ reflect: true, digest: true, embeddings: true, todo: true });

      useSettingsStore.getState().setCapabilities(null);

      expect(useSettingsStore.getState().capabilities).toBeNull();
      expect(localStorage.getItem("meologue.capabilities")).toBeNull();
    });

    it("does not throw when localStorage refuses the write, and still updates the store", () => {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });
      const capabilities = { reflect: false, digest: true, embeddings: false, todo: true };

      expect(() => useSettingsStore.getState().setCapabilities(capabilities)).not.toThrow();
      expect(useSettingsStore.getState().capabilities).toEqual(capabilities);
    });
  });

  describe("refreshCapabilities", () => {
    it("stores the server's capability report and marks the server reachable", async () => {
      const capabilities = { reflect: true, digest: false, embeddings: false, todo: true };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => healthResponse(capabilities)),
      );
      useSettingsStore.getState().setServerUrl("https://server.example");

      await refreshCapabilities();

      expect(useSettingsStore.getState().capabilities).toEqual(capabilities);
      expect(useSettingsStore.getState().serverReachable).toBe(true);
    });

    // Required: an omitted capability report reads as unknown (never
    // "every capability off"), and `chat-list.tsx` treats unknown as
    // unlocked — see `readStoredCapabilities`'s own doc comment.
    it("degrades to unknown (optimistic) capabilities when the server omits the field", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => healthResponse(undefined)),
      );
      useSettingsStore.getState().setServerUrl("https://server.example");
      useSettingsStore
        .getState()
        .setCapabilities({ reflect: true, digest: true, embeddings: true, todo: true });

      await refreshCapabilities();

      expect(useSettingsStore.getState().capabilities).toBeNull();
      expect(useSettingsStore.getState().serverReachable).toBe(true);
    });

    // Required: a network-level failure marks the server unreachable but
    // leaves a previously-known capability report alone — the Server going
    // quiet for a moment says nothing about what it could serve the last
    // time it answered.
    it("marks the server unreachable on a network failure, without touching a known capability report", async () => {
      const capabilities = { reflect: true, digest: true, embeddings: false, todo: true };
      useSettingsStore.getState().setServerUrl("https://server.example");
      useSettingsStore.getState().setCapabilities(capabilities);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      );

      await refreshCapabilities();

      expect(useSettingsStore.getState().serverReachable).toBe(false);
      expect(useSettingsStore.getState().capabilities).toEqual(capabilities);
    });

    it("clears the capability cache and reports reachable when the server URL is empty", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      useSettingsStore
        .getState()
        .setCapabilities({ reflect: true, digest: true, embeddings: true, todo: true });
      useSettingsStore.getState().setServerReachable(false);

      await refreshCapabilities();

      expect(useSettingsStore.getState().capabilities).toBeNull();
      expect(useSettingsStore.getState().serverReachable).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
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

  // Issue #133: `null` (unknown) is the only safe cold-start value —
  // `chat-list.tsx` reads it as "unlocked," so any of these degrading to
  // "every capability false" would falsely lock a working Server on a cold
  // launch, exactly the failure mode Part 2's "unknown means unlocked" rule
  // exists to rule out.
  it("defaults capabilities to null (unknown) when nothing is stored", async () => {
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().capabilities).toBeNull();
  });

  it("defaults capabilities to null (unknown) for a malformed stored value", async () => {
    localStorage.setItem("meologue.capabilities", JSON.stringify({ reflect: "yes" }));
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().capabilities).toBeNull();
  });

  it("degrades capabilities to null (unknown, optimistic) when localStorage throws on read", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().capabilities).toBeNull();
  });

  it("picks up an already-stored capability report", async () => {
    const capabilities = { reflect: true, digest: false, embeddings: true };
    localStorage.setItem("meologue.capabilities", JSON.stringify(capabilities));
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().capabilities).toEqual(capabilities);
  });

  it("defaults serverReachable to true (optimistic)", async () => {
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().serverReachable).toBe(true);
  });

  it("defaults the completed checklist item style to grayed out when nothing is stored", async () => {
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().completedStyle).toBe("gray");
  });

  it("defaults the completed checklist item style to grayed out when localStorage throws on read", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().completedStyle).toBe("gray");
  });

  it("picks up an already-stored completed checklist item style", async () => {
    localStorage.setItem("meologue.completed-style", "none");
    const { useSettingsStore: fresh } = await import("./settings");
    expect(fresh.getState().completedStyle).toBe("none");
  });
});
