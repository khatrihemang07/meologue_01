import { describe, expect, it } from "vitest";
import { isSubmitChord, submitHint } from "./submit-chord";

// Every case below passes `mode` explicitly rather than relying on
// vitest's own `import.meta.env.MODE` ("test") — the whole point of
// threading mode through as a parameter (see submit-chord.ts's doc
// comment) is that these rules are exercisable without env stubbing.
function event(overrides: Partial<Parameters<typeof isSubmitChord>[0]> = {}) {
  return { key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, ...overrides };
}

describe("isSubmitChord", () => {
  describe('mode: "android"', () => {
    it("never submits, even with every modifier held", () => {
      expect(isSubmitChord(event(), "android")).toBe(false);
      expect(isSubmitChord(event({ metaKey: true }), "android")).toBe(false);
      expect(isSubmitChord(event({ ctrlKey: true }), "android")).toBe(false);
      expect(isSubmitChord(event({ metaKey: true, ctrlKey: true }), "android")).toBe(false);
    });
  });

  describe('mode: "macos"', () => {
    it("submits on Cmd+Enter", () => {
      expect(isSubmitChord(event({ metaKey: true }), "macos")).toBe(true);
    });

    it("does not submit on Ctrl+Enter alone — Cmd is the platform's modifier", () => {
      expect(isSubmitChord(event({ ctrlKey: true }), "macos")).toBe(false);
    });

    it("does not submit on plain Enter", () => {
      expect(isSubmitChord(event(), "macos")).toBe(false);
    });
  });

  describe('mode: "web" (and other non-Android, non-macOS builds)', () => {
    it("submits on Cmd+Enter", () => {
      expect(isSubmitChord(event({ metaKey: true }), "web")).toBe(true);
    });

    it("submits on Ctrl+Enter", () => {
      expect(isSubmitChord(event({ ctrlKey: true }), "web")).toBe(true);
    });

    it("does not submit on plain Enter", () => {
      expect(isSubmitChord(event(), "web")).toBe(false);
    });

    it("falls through to the same rule for the sandbox target", () => {
      expect(isSubmitChord(event({ metaKey: true }), "sandbox")).toBe(true);
      expect(isSubmitChord(event({ ctrlKey: true }), "sandbox")).toBe(true);
    });

    it('falls through to the same rule for vitest\'s own "test" mode', () => {
      expect(isSubmitChord(event({ metaKey: true }), "test")).toBe(true);
      expect(isSubmitChord(event({ ctrlKey: true }), "test")).toBe(true);
    });
  });

  it("is never true when Shift is held, on any mode or modifier combination", () => {
    for (const mode of ["android", "macos", "web", "sandbox", "test"]) {
      expect(isSubmitChord(event({ shiftKey: true, metaKey: true }), mode)).toBe(false);
      expect(isSubmitChord(event({ shiftKey: true, ctrlKey: true }), mode)).toBe(false);
    }
  });

  it("is never true for a key other than Enter", () => {
    expect(isSubmitChord(event({ key: "a", metaKey: true }), "web")).toBe(false);
  });

  it('defaults `mode` to import.meta.env.MODE, which is "test" under vitest', () => {
    expect(isSubmitChord(event({ metaKey: true }))).toBe(true);
    expect(isSubmitChord(event({ ctrlKey: true }))).toBe(true);
    expect(isSubmitChord(event())).toBe(false);
  });
});

describe("submitHint", () => {
  it('is null on "android" — there is no chord to advertise', () => {
    expect(submitHint("android")).toBeNull();
  });

  it('names only Cmd on "macos"', () => {
    expect(submitHint("macos")).toBe("⌘↵ to send");
  });

  it("names both modifiers on web (and sandbox, and test)", () => {
    expect(submitHint("web")).toBe("⌘↵ or Ctrl↵ to send");
    expect(submitHint("sandbox")).toBe("⌘↵ or Ctrl↵ to send");
    expect(submitHint("test")).toBe("⌘↵ or Ctrl↵ to send");
  });

  it("defaults `mode` to import.meta.env.MODE", () => {
    expect(submitHint()).toBe("⌘↵ or Ctrl↵ to send");
  });
});
